#!/usr/bin/env node
/**
 * Folds an operator's duplicate agents - one per worktree, one per checkout -
 * onto the single identity their git remote names, and re-keys the survivor on
 * that remote. Dry run by default: prints exactly what it would merge into
 * what, and exits. Pass --confirm to perform it.
 *
 *   DATABASE_URL=postgres://... node scripts/repair-agent-identity-by-remote.mjs [--confirm]
 *
 * Identity used to be (organization, owner, source, repo_root), and a repo
 * root is a *path*. Every treehouse worktree is its own path, so every worktree
 * minted its own agent; because the display name is composed from the last
 * segment, five different identities all rendered "Claude Code @ precisiondocs".
 * Keyed by path, displayed by basename. Two checkouts of one GitHub repository
 * under different directory names - `C:\dev\PrecisionDocs-AI` and
 * `C:\dev\code-goblins\projects\precisiondocs` - are the same defect with no
 * basename to compare at all.
 *
 * `0016_agent_identity_by_remote` moved the key onto `agents.repo_key` and
 * carried every existing row across as `path:<root>`, which preserves exactly
 * the identity it already had. This upgrades those keys to remotes and merges
 * whatever collapses together.
 *
 * **The remote is not in the database.** Nothing has ever uploaded it, so it
 * can only be read from a machine that holds the checkouts - which is why this
 * runs locally against the shared database rather than as a migration. A row
 * whose `repo_root` is not a directory on this machine is left exactly as it
 * is and reported; that is what keeps another operator's rows out of a repair
 * run by whoever happens to have the database URL.
 *
 * Rules, none of them negotiable:
 *
 * - **Merge, never delete.** Shifts, `shift_commits` and `agent_usage` all
 *   follow their agent onto the survivor, and the emptied row is retired, not
 *   removed. A repair that loses a shift is worse than the duplicates.
 * - **Idempotent.** A second run finds every group already collapsed and every
 *   key already correct, and does nothing.
 * - **A name a member chose is not ours to revisit.** A `registered` row wins
 *   its group; a group holding two of them is refused whole rather than
 *   picking one.
 * - **Everything is decided before anything is written.** `planRepair` settles
 *   every group, every winner and every target key against the rows as they
 *   are now, and validates each target against the live rows that hold keys;
 *   the writer only executes what the dry run printed. A group whose key is
 *   held by a row outside it is refused there, not discovered by a unique
 *   violation two transactions into the run.
 *
 * It also reports the unassigned bucket without touching it: how much of that
 * time was genuinely unattributable and how much is a resolution failure.
 * Re-homing those shifts is `repair-run-named-agents.mjs`'s job. The two
 * repairs are independent, and this one is the better first move: it reads
 * `remote.origin.url` out of the directory `repo_root` names, while the fold
 * moves a row to the bucket and discards that root.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import process from "node:process";

import postgres from "postgres";

import registry from "../packages/shared/src/agent-runtimes.json" with { type: "json" };

/**
 * The one implementation of each rule, imported rather than mirrored: a
 * normalizer that drifts here does not just mislabel a row, it decides which
 * agents get merged, and a label rule that drifts leaves a repaired roster
 * reading differently from a freshly minted one. Node strips the types
 * (22.18+, 23.6+, 24+).
 */
let normalizeRemote;
let repoLabel;
let agentCodebaseLabel;
try {
  ({ normalizeRemote, repoLabel, agentCodebaseLabel } = await import("../apps/api/src/services/attribution.ts"));
} catch (error) {
  console.error("Could not load apps/api/src/services/attribution.ts.");
  console.error("This script reads the API's own normalizer rather than copying it, which needs a Node that strips types (22.18+, 23.6+ or 24+).");
  console.error(String(error));
  process.exit(2);
}

const confirm = process.argv.includes("--confirm");

/** Opened by the entrypoint at the foot of this file, so an import connects to nothing. */
let sql;

/** The declared runtimes' display names, from the one roster both sides read. */
const runtimeLabels = new Map(registry.runtimes.map((runtime) => [runtime.id, runtime.label]));

/**
 * The key an agent should carry, and how sure we are of it.
 *
 * - `remote`: the checkout is here and `origin` names a repository, so the key
 *   is that repository and every other checkout of it folds onto the same row.
 * - `local-only`: the checkout is here and has no remote to name. Not a
 *   failure - a repository nobody pushed anywhere is legitimate, and its own
 *   directory is the right identity for it, which is what it already had.
 * - `unreadable`: the directory is not on this machine, is no longer a
 *   repository, or git could not be run. We cannot say, so nothing changes and
 *   the row is reported. This is what keeps another operator's rows out of a
 *   repair run by whoever happens to hold the database URL.
 */
function resolveKey(agent) {
  const pathKey = `path:${agent.repo_root}`;
  let present = false;
  try {
    present = statSync(agent.repo_root).isDirectory();
  } catch {
    present = false;
  }
  if (!present) return { key: pathKey, status: "unreadable", detail: "no such directory on this machine" };

  let remote;
  try {
    remote = execFileSync("git", ["-C", agent.repo_root, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
  } catch {
    // `config --get` exits non-zero when the key is unset, which is also how a
    // directory that is no longer a repository looks. Both mean "no origin
    // here", and both leave the row alone.
    return { key: pathKey, status: "local-only", detail: "the checkout is here and has no origin remote" };
  }
  if (remote === "") return { key: pathKey, status: "local-only", detail: "the checkout is here and has no origin remote" };
  const normalized = normalizeRemote(remote);
  if (normalized === null) {
    return { key: pathKey, status: "local-only", detail: `origin names a directory rather than a host (${remote})` };
  }
  return { key: normalized, status: "remote", detail: remote };
}

/**
 * The name the API would compose for this row, so a repaired roster reads
 * exactly like a freshly minted one: the same runtime label beside the same
 * `agentCodebaseLabel` that `defaultAgentName` in
 * apps/api/src/drizzle-repositories.ts composes, clamped to the 200 characters
 * `agents_name_length_valid` allows.
 */
function defaultName(source, repoRoot, key) {
  const runtime = runtimeLabels.get(source) ?? source;
  return `${runtime} @ ${agentCodebaseLabel(repoRoot, key) ?? "unassigned"}`.slice(0, 200);
}

/** Registered beats anonymous - a member named it - then oldest, then id. */
function pickWinner(group) {
  return [...group].sort((left, right) => {
    if ((left.status === "registered") !== (right.status === "registered")) {
      return left.status === "registered" ? -1 : 1;
    }
    const byAge = left.created_at.getTime() - right.created_at.getTime();
    return byAge !== 0 ? byAge : left.id.localeCompare(right.id);
  })[0];
}

/**
 * Refuses a database that is not Clock-In's, before anything else runs.
 *
 * `DATABASE_URL` is an ambient environment variable shared with whatever else
 * the shell was doing, and a stale one points at a stranger's database. This
 * script merges and retires rows: pointed at the wrong database with
 * `--confirm`, it would be operating on someone else's data before the first
 * error surfaced. So the very first statement asks whether `agents` exists and
 * carries the column this repair is about, and a database that answers no is
 * refused rather than probed further.
 */
async function requireClockInSchema() {
  const [found] = await sql`
    select
      to_regclass('public.agents') is not null as has_agents,
      exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'agents' and column_name = 'repo_key'
      ) as has_repo_key
  `;
  if (!found.has_agents) {
    console.error("This database has no `agents` table, so it is not Clock-In's. Refusing to touch it.");
    console.error("Check DATABASE_URL - it is an ambient variable and a stale one points somewhere else entirely.");
    await sql.end();
    process.exit(2);
  }
  if (!found.has_repo_key) {
    console.error("`agents` has no `repo_key` column: this database has not had migration 0016_agent_identity_by_remote applied.");
    console.error("Apply it first; this repair upgrades the keys that migration creates.");
    await sql.end();
    process.exit(2);
  }
}

/**
 * What this run would do, decided before anything is printed or written.
 *
 * The rule the whole script rests on: a key we cannot verify is never written.
 * A row whose `repo_root` is not a directory on this machine is inert - never
 * a group member, never a merge winner or loser, never re-keyed - because the
 * only key we could compose for it is `path:<root>`, and writing that over a
 * remote key would split that repository back across its worktrees, which is
 * the defect this script exists to undo. That is every row belonging to
 * another operator, since the documented workflow is for each operator to run
 * this on their own machine; it is also what keeps a second run idempotent
 * once a worktree has been deleted.
 *
 * A `local-only` row does take part: its own directory is the right identity
 * for a repository with no remote, and it is the key that row already carries,
 * so it settles without a write. The one exception is a row whose origin was
 * removed after it had been keyed on that remote - demoting it would be the
 * same split by another route, so it is refused too.
 *
 * Inert cuts both ways, which is what `contended` is for. A row this run
 * cannot read still holds its key, and the unique index covers exactly the
 * live rows, so a group resolving to a key such a row holds is refused whole
 * rather than merged into it or re-keyed past it. A later run from the machine
 * that holds that checkout resolves the pair properly.
 *
 * `resolve` is injected so this can be exercised without checkouts on disk.
 */
export function planRepair(agents, resolve = resolveKey) {
  const refusals = [];
  const localOnly = [];
  const contended = [];
  const groups = new Map();
  // Every live row by the key it already holds, whether or not this run can
  // read its checkout - and rows with no repo root at all, which can hold a
  // remote key without ever being a candidate. The partial unique covers
  // exactly these rows, so a key one of them holds is a key no write in this
  // plan may target.
  const scopedKey = (agent, key) => `${agent.organization_id}|${agent.owner_user_id}|${agent.source}|${key}`;
  const liveByKey = new Map();
  for (const agent of agents) {
    if (agent.repo_key === null) continue;
    liveByKey.set(scopedKey(agent, agent.repo_key), agent);
  }
  for (const agent of agents) {
    // Nothing to probe and nothing to re-key: the operator's unassigned
    // bucket, or a row a remote identified without naming a directory.
    if (agent.repo_root === null) continue;
    const { key, status, detail } = resolve(agent);
    if (status === "unreadable") {
      refusals.push({ agent, detail });
      continue;
    }
    const remoteKeyed = agent.repo_key !== null && !agent.repo_key.startsWith("path:");
    if (status === "local-only") {
      if (remoteKeyed) {
        refusals.push({ agent, detail: `${detail}, and the row is already keyed on ${agent.repo_key}` });
        continue;
      }
      localOnly.push({ agent, detail });
    }
    const groupKey = `${agent.organization_id}|${agent.owner_user_id}|${agent.source}|${key}`;
    const existing = groups.get(groupKey);
    if (existing === undefined) groups.set(groupKey, { key, members: [agent] });
    else existing.members.push(agent);
  }

  const merges = [];
  const rekeys = [];
  const ambiguous = [];
  for (const group of groups.values()) {
    // Both write paths end in the same statement - `set repo_key = <the
    // group's key>` on whichever row survives - so both need the same question
    // asked first, and it has to be asked here rather than at either writer. A
    // row outside this group already holding that key is typically one this
    // run refused to read, keyed from a machine that could read it. Refuse the
    // group: merging into that row would have it receive another row's shifts,
    // which is not what "a row we cannot read is inert" means, and re-keying
    // past it aborts the run after earlier merges have already committed.
    const holder = liveByKey.get(scopedKey(group.members[0], group.key));
    if (holder !== undefined && !group.members.some((agent) => agent.id === holder.id)) {
      contended.push({ key: group.key, members: group.members, holder });
      continue;
    }
    const named = group.members.filter((agent) => agent.status === "registered");
    if (named.length > 1) {
      // Two names a member chose, one repository. Which name survives is a
      // decision about someone's roster, not a mechanical merge.
      ambiguous.push(group);
      continue;
    }
    if (group.members.length > 1) {
      const winner = pickWinner(group.members);
      merges.push({ key: group.key, winner, losers: group.members.filter((agent) => agent.id !== winner.id) });
      continue;
    }
    const only = group.members[0];
    if (only.repo_key !== group.key) rekeys.push({ key: group.key, agent: only });
  }
  return { merges, rekeys, ambiguous, contended, localOnly, refusals };
}

async function main() {
  await requireClockInSchema();
  const agents = await sql`
    select a.id, a.organization_id, a.owner_user_id, a.source, a.repo_root, a.repo_key,
           a.name, a.status, a.created_at, u.name as owner_name,
           (select count(*)::int from agent_sessions s where s.organization_id = a.organization_id and s.agent_id = a.id) as shifts,
           (select count(*)::int from shift_commits c where c.organization_id = a.organization_id and c.agent_id = a.id) as commits,
           (select count(*)::int from agent_usage g where g.organization_id = a.organization_id and g.agent_id = a.id) as usage_rows
    from agents a
    join users u on u.organization_id = a.organization_id and u.id = a.owner_user_id
    where a.status <> 'retired'
    order by a.organization_id, u.name, a.source, a.created_at, a.id
  `;
  // Rows with no repo root are read only for the keys they hold: there is
  // nothing to probe and nothing to re-key on them.
  const considered = agents.filter((agent) => agent.repo_root !== null);

  console.log(`Clock-In agent identity repair, keyed on the git remote. ${confirm ? "Applying." : "Dry run."}`);
  console.log(`${considered.length} live repo-keyed agent(s) to consider.\n`);

  const { merges, rekeys, ambiguous, contended, localOnly, refusals } = planRepair(agents);

  const describe = (agent) =>
    `${agent.name} (${agent.id.slice(0, 8)}) ${agent.shifts} shift(s), ${agent.commits} commit(s), ${agent.usage_rows} usage row(s)`;

  if (merges.length === 0) {
    console.log("No two agents share a repository. Nothing to merge.");
  } else {
    console.log(`${merges.length} repository/repositories hold more than one agent:\n`);
    for (const merge of merges) {
      console.log(`  ${merge.key}  [${merge.winner.owner_name} / ${merge.winner.source}]`);
      console.log(`    keep   ${describe(merge.winner)}`);
      for (const loser of merge.losers) console.log(`    merge  ${describe(loser)}`);
      console.log(`    root   ${merge.winner.repo_root}`);
      console.log("");
    }
  }

  if (rekeys.length > 0) {
    console.log(`${rekeys.length} agent(s) already alone on their repository, re-keyed onto its remote:`);
    for (const rekey of rekeys) console.log(`    ${rekey.agent.name} (${rekey.agent.id.slice(0, 8)})  ${rekey.agent.repo_key} -> ${rekey.key}`);
    console.log("");
  }

  if (ambiguous.length > 0) {
    console.log(`${ambiguous.length} group(s) refused: more than one agent there carries a name a member chose.`);
    for (const group of ambiguous) {
      console.log(`    ${group.key}`);
      for (const agent of group.members) console.log(`      ${agent.status.padEnd(10)} ${describe(agent)}`);
    }
    console.log("    Rename or merge these by hand; a name someone chose is not this script's to drop.\n");
  }

  if (contended.length > 0) {
    console.log(`${contended.length} group(s) refused: another live agent already holds the key they resolve to.`);
    for (const clash of contended) {
      console.log(`    ${clash.key}`);
      for (const agent of clash.members) console.log(`      resolves  ${agent.id} ${describe(agent)}`);
      console.log(`      holds     ${clash.holder.id} ${describe(clash.holder)}`);
      console.log(`      root      ${clash.holder.repo_root ?? "(none recorded)"}`);
      console.log("      That row is not one this run can read, so it is not one this run may merge into or re-key past.");
    }
    console.log("    Run this from the machine holding the other row's checkout, or resolve the two by hand.\n");
  }

  if (localOnly.length > 0) {
    console.log(`${localOnly.length} agent(s) keyed on their own directory, which is the right answer for them:`);
    for (const entry of localOnly) {
      console.log(`    ${entry.agent.owner_name.padEnd(18)} ${entry.agent.name} (${entry.agent.id.slice(0, 8)})  ${entry.detail}`);
      console.log(`      ${entry.agent.repo_root}`);
    }
    console.log("    A repository with no remote is legitimate and keeps its own identity, rather than pooling with every other one.\n");
  }

  if (refusals.length > 0) {
    console.log(`${refusals.length} agent(s) refused - their remote cannot be read from this machine, so nothing about them changes:`);
    for (const refusal of refusals) {
      console.log(`    ${refusal.agent.owner_name.padEnd(18)} ${refusal.agent.name} (${refusal.agent.id.slice(0, 8)})`);
      console.log(`      ${refusal.agent.repo_root}`);
      console.log(`      ${refusal.detail}`);
    }
    console.log("    Run this from a machine that holds those checkouts to fold them too.\n");
  }

  const movedShifts = merges.reduce((total, merge) => total + merge.losers.reduce((sum, loser) => sum + loser.shifts, 0), 0);
  const movedCommits = merges.reduce((total, merge) => total + merge.losers.reduce((sum, loser) => sum + loser.commits, 0), 0);
  const movedUsage = merges.reduce((total, merge) => total + merge.losers.reduce((sum, loser) => sum + loser.usage_rows, 0), 0);
  const retiring = merges.reduce((total, merge) => total + merge.losers.length, 0);

  console.log("Counts");
  console.log(`  agents before          ${considered.length}`);
  console.log(`  agents after           ${considered.length - retiring}`);
  console.log(`  shifts moved           ${movedShifts}`);
  console.log(`  commits to move        ${movedCommits}`);
  console.log(`  usage rows to move     ${movedUsage}`);
  console.log(`  re-keyed in place      ${rekeys.length}`);
  console.log(`  keyed on a directory   ${localOnly.length}`);
  const refusedRows = refusals.length
    + ambiguous.reduce((total, group) => total + group.members.length, 0)
    + contended.reduce((total, clash) => total + clash.members.length, 0);
  console.log(`  refused                ${refusedRows}`);

  await reportUnassignedBucket();

  if (!confirm) {
    console.log("\nDry run: nothing was written. Pass --confirm to perform the merges and re-keys above.");
    await sql.end();
    return;
  }

  let mergedAgents = 0;
  let heldCommits = 0;
  let actuallyMovedShifts = 0;
  let actuallyMovedCommits = 0;
  let rekeyed = 0;
  const applied = () => {
    console.log(`\nMerged ${mergedAgents} agent(s) in, carrying ${actuallyMovedShifts} shift(s) and ${actuallyMovedCommits} commit(s). No evidence row was deleted.`);
    if (heldCommits > 0) {
      console.log(`${heldCommits} commit(s) stayed on a retired row: the surviving agent already records that sha for the same repository.`);
    }
    console.log(`Re-keyed ${rekeyed} agent(s) already alone on their repository.`);
  };
  // Each merge and each re-key is its own transaction, so a failure part way
  // through leaves the ones before it applied. That is recoverable, because a
  // second run picks up exactly where this one stopped - but only if the
  // operator is told what landed rather than left reading a bare stack trace.
  try {
    for (const merge of merges) {
      await sql.begin(async (tx) => {
        for (const loser of merge.losers) {
          const shifts = await tx`
            update agent_sessions set agent_id = ${merge.winner.id}, updated_at = now()
            where organization_id = ${loser.organization_id} and agent_id = ${loser.id}
            returning id
          `;
          actuallyMovedShifts += shifts.length;
          // `shift_commits` and `agent_usage` carry their own `agent_id`, so the
          // evidence does not follow its shift on its own: re-pointing only the
          // shift would strand every commit tally and token total on the row
          // being retired. The commit move is guarded the way
          // DrizzleAgentRepository.merge guards its own - two worktrees of one
          // repository can both have recorded the same sha, and
          // (organization, agent, repo_root, sha) is unique - so a duplicate
          // sighting stays where it is rather than aborting the merge. It is
          // still counted, never dropped.
          const commits = await tx`
            update shift_commits as loser_commits set agent_id = ${merge.winner.id}, updated_at = now()
            where loser_commits.organization_id = ${loser.organization_id}
              and loser_commits.agent_id = ${loser.id}
              and not exists (
                select 1 from shift_commits as winner_commits
                where winner_commits.organization_id = loser_commits.organization_id
                  and winner_commits.agent_id = ${merge.winner.id}
                  and winner_commits.repo_root = loser_commits.repo_root
                  and winner_commits.sha = loser_commits.sha
              )
            returning loser_commits.id
          `;
          actuallyMovedCommits += commits.length;
          const held = await tx`
            select id from shift_commits
            where organization_id = ${loser.organization_id} and agent_id = ${loser.id}
          `;
          heldCommits += held.length;
          // `agent_usage` needs no guard: its bucket unique is keyed on
          // agent_session_id, which does not move, so re-pointing cannot collide.
          await tx`
            update agent_usage set agent_id = ${merge.winner.id}, updated_at = now()
            where organization_id = ${loser.organization_id} and agent_id = ${loser.id}
          `;
          // Retired before the winner takes the key: the partial unique excludes
          // retired rows, so releasing the losers' keys first is what lets the
          // winner claim the one they all resolve to.
          await tx`
            update agents set status = 'retired', updated_at = now()
            where organization_id = ${loser.organization_id} and id = ${loser.id}
          `;
          mergedAgents += 1;
        }
        await tx`
          update agents
          set repo_key = ${merge.key},
              name = case when status = 'registered' then name else ${defaultName(merge.winner.source, merge.winner.repo_root, merge.key)} end,
              updated_at = now()
          where organization_id = ${merge.winner.organization_id} and id = ${merge.winner.id}
        `;
      });
    }

    for (const rekey of rekeys) {
      await sql`
        update agents
        set repo_key = ${rekey.key},
            name = case when status = 'registered' then name else ${defaultName(rekey.agent.source, rekey.agent.repo_root, rekey.key)} end,
            updated_at = now()
        where organization_id = ${rekey.agent.organization_id} and id = ${rekey.agent.id}
      `;
      rekeyed += 1;
    }
  } catch (error) {
    console.error("\nStopped part way through. What had already been applied:");
    applied();
    throw error;
  }

  const [after] = await sql`select count(*)::int as count from agents where repo_root is not null and status <> 'retired'`;
  applied();
  console.log(`Live repo-keyed agents now: ${after.count}.`);
  await sql.end();
}

/**
 * The unassigned bucket, read and never written. The roster shows one row
 * holding far more time than any codebase's, which says the resolution was
 * failing rather than that the work was really unattributable - so the
 * question "how much of each?" deserves a number rather than a shrug.
 *
 * Four answers, in order of how much they let us say:
 *
 * - a shift whose own commit names a codebase is a resolution failure with
 *   proof, and `repair-run-named-agents.mjs` re-homes exactly these;
 * - a shift whose working directory names a codebase probably is one too - a
 *   hook older than the repo probe reported no root at all - but a directory
 *   is not proof that it was a repository;
 * - a shift whose directory names only a run belongs in the bucket;
 * - a shift with no directory at all is genuinely unattributable.
 */
async function reportUnassignedBucket() {
  const shifts = await sql`
    select s.id, s.cwd, u.name as owner_name,
           extract(epoch from (coalesce(s.ended_at, s.last_event_at) - s.started_at))::int as seconds,
           (select c.repo_root from shift_commits c
             where c.organization_id = s.organization_id and c.agent_session_id = s.id
             order by c.authored_at, c.id limit 1) as commit_root
    from agent_sessions s
    join agents a on a.organization_id = s.organization_id and a.id = s.agent_id
    join users u on u.organization_id = s.organization_id and u.id = s.user_id
    where a.repo_key is null and a.status <> 'retired' and s.source <> 'browser'
  `;
  const buckets = {
    "resolution failure, its own commit names the codebase": [],
    "probably a resolution failure, its directory names a codebase": [],
    "honestly unassigned, its directory names only a run": [],
    "honestly unassigned, no working directory recorded": [],
  };
  for (const shift of shifts) {
    if (shift.commit_root !== null && repoLabel(shift.commit_root) !== null) {
      buckets["resolution failure, its own commit names the codebase"].push(shift);
    } else if (shift.cwd === null) {
      buckets["honestly unassigned, no working directory recorded"].push(shift);
    } else if (repoLabel(shift.cwd) !== null) {
      buckets["probably a resolution failure, its directory names a codebase"].push(shift);
    } else {
      buckets["honestly unassigned, its directory names only a run"].push(shift);
    }
  }
  const hours = (rows) => (rows.reduce((total, row) => total + Math.max(row.seconds ?? 0, 0), 0) / 3_600).toFixed(1);

  console.log(`\nThe unassigned bucket: ${shifts.length} shift(s), ${hours(shifts)}h, untouched by this script.`);
  for (const [reason, rows] of Object.entries(buckets)) {
    console.log(`  ${String(rows.length).padStart(5)} shift(s)  ${hours(rows).padStart(7)}h  ${reason}`);
  }
  const labels = new Map();
  for (const shift of shifts) {
    const label = shift.commit_root === null ? (shift.cwd === null ? null : repoLabel(shift.cwd)) : repoLabel(shift.commit_root);
    labels.set(label ?? "(no codebase)", (labels.get(label ?? "(no codebase)") ?? 0) + 1);
  }
  const top = [...labels.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12);
  if (top.length > 0) {
    console.log("  The labels the Agents tab renders for it, by shift count:");
    for (const [label, count] of top) console.log(`    ${String(count).padStart(5)}  ${label}`);
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("repair-agent-identity-by-remote.mjs")) {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error("DATABASE_URL is required.");
    process.exit(2);
  }
  sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  main().catch(async (error) => {
    console.error(error);
    await sql.end({ timeout: 5 });
    process.exit(1);
  });
}
