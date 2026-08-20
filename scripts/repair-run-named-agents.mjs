#!/usr/bin/env node
/**
 * Folds agents named after a run back into their operator's unassigned bucket,
 * and clears the placeholder models stored beside them. Dry run by default:
 * prints exactly what would move and exits. Pass --confirm to perform it.
 *
 *   DATABASE_URL=postgres://... node scripts/repair-run-named-agents.mjs [--confirm]
 *
 * Tooling that checks a repo out per run leaves a working directory named after
 * the run rather than the codebase - a no-mistakes gate worktree lives at
 * `<hash>.git/worktrees/<ULID>`. Because identity keys on the repo root, every
 * such run minted its own agent, and because the default name is composed from
 * the root's last segment, each read
 * "Claude Code @ 01M06FSGP392MH6VJNRX8T364A". The identity-v2 backfill did not
 * create these; it re-attributed shifts onto the roots the commits named, which
 * is what surfaced them at scale.
 *
 * The API now refuses an opaque segment as a codebase name (`repoLabel`) and as
 * an identity key (`identityRepoRoot`), so no new row can be minted this way.
 * This repairs the rows already stored.
 *
 * Since `0016_agent_identity_by_remote` a row is keyed on `agents.repo_key`
 * and its `repo_root` is only evidence of where the work happened, so a row
 * whose key names a repository is never folded however its directory reads: a
 * gate worktree of a real repository is correctly identified, not run-named.
 *
 * Each run-named agent merges into the one unassigned agent for its
 * (organization, owner, source): shifts, `shift_commits` and `agent_usage`
 * follow, then the emptied row is retired. Nothing is deleted, and an agent a
 * member has renamed is left alone - a name someone chose is not ours to
 * revisit, even on a row keyed this way.
 *
 * It also re-homes bucket shifts that carry their own commit evidence. A hook
 * older than the repo probe reported no repo root at all, so every shift
 * minted into its operator's unassigned bucket even when it ran in a real
 * checkout. A commit's repo root is proof the directory really was a
 * repository; a recorded cwd alone is not - a shift launched in any real
 * non-repo directory is bucketed by design with that cwd stored. Each shift
 * with a commit moves onto the codebase its first commit names (first by
 * authored_at then id, the rule the paystub and graduation already follow):
 * an existing agent of the same (organization, owner, source) rendering the
 * same codebase label when there is one, else a fresh identity keyed on
 * `path:<that commit's repo root>`, which is what `identityRepoKey` composes
 * when no remote is known. A root whose last segment is opaque stays put - a
 * gate worktree's commit reports the worktree path, which names only a run.
 * A shift with no commit stays in the bucket, which is self-limiting: no date
 * cutoff is needed, and a re-run stays safe forever.
 *
 * It also clears the model a runtime never attested. A CLI marks the entries
 * it writes about itself - Claude Code stamps them `<synthetic>` - and a
 * desktop old enough to read one out of a transcript stored it as the shift's
 * model, which is why the roster read "Claude Code · <synthetic>". Both the
 * reader and the API refuse it now, but the rows already stored keep rendering
 * it until they are nulled. `agent_usage.model` is deliberately left alone:
 * its bucket unique is nullsNotDistinct and the upsert folds with GREATEST, so
 * collapsing two distinct buckets onto null would undercount the tokens.
 */
import process from "node:process";

import postgres from "postgres";

import registry from "../packages/shared/src/agent-runtimes.json" with { type: "json" };

/**
 * The one implementation, imported rather than mirrored. This script keeps no
 * copy of the opaque-segment rule any more: which rows get folded into a
 * bucket and which shifts get re-homed are both decided by it, so a mirror one
 * branch behind folds a row the API considers perfectly named. Node strips the
 * types (22.18+, 23.6+, 24+).
 */
let repoLabel;
let agentCodebaseLabel;
try {
  ({ repoLabel, agentCodebaseLabel } = await import("../apps/api/src/services/attribution.ts"));
} catch (error) {
  console.error("Could not load apps/api/src/services/attribution.ts.");
  console.error("This script reads the API's own codebase-label rule rather than copying it, which needs a Node that strips types (22.18+, 23.6+ or 24+).");
  console.error(String(error));
  process.exit(2);
}

const confirm = process.argv.includes("--confirm");

/** Opened by the entrypoint at the foot of this file, so an import connects to nothing. */
let sql;

/** The declared runtimes' display names, from the one roster both sides read. */
const runtimeLabels = new Map(registry.runtimes.map((runtime) => [runtime.id, runtime.label]));

const namesOnlyARun = (repoRoot) => repoRoot !== null && repoLabel(repoRoot) === null;

/**
 * A row keyed on a real repository, whatever its directory happens to read as.
 *
 * `0016_agent_identity_by_remote` moved identity onto `agents.repo_key`, and
 * the API now stores the repo root as evidence of where the work happened
 * rather than as the key. A shift run inside a gate worktree of a real
 * repository therefore mints a correctly keyed row - `github.com/owner/repo` -
 * that still carries a run-named `repo_root`. Folding that into the operator's
 * unassigned bucket would destroy the very attribution
 * `repair-agent-identity-by-remote.mjs` exists to establish, so the directory
 * is never the last word: a remote key outranks whatever it reads as.
 */
const keyedOnARepository = (agent) => agent.repo_key !== null && !agent.repo_key.startsWith("path:");

/**
 * The row that already carries this codebase, or undefined.
 *
 * Oldest matching label wins, deterministically; the label is what every
 * surface renders, so which clone's row carries the shift does not change what
 * anyone reads. A remote-keyed row is matched on the repository its key names,
 * which is the whole point of the key: a commit authored in one worktree
 * reaches the repository's own row.
 *
 * The comparison folds case and nothing else does. `repoLabel` keeps a
 * directory's own capitalisation (`Clock-In`, `PrecisionDocs-AI`) while
 * `normalizeRemote` lowercases a remote deliberately, because GitHub treats
 * `Owner/Repo` and `owner/repo` as one repository - so a capitalised checkout
 * would never match its own remote-keyed row, and this would mint a second row
 * for it. Duplicating a row inside the script that repairs duplicated rows.
 * Only the match folds: what is stored and displayed is untouched.
 */
export function findCodebaseRow(candidates, label) {
  const wanted = label.toLowerCase();
  return candidates.find((agent) => agentCodebaseLabel(agent.repo_root, agent.repo_key)?.toLowerCase() === wanted);
}

/** A row the fold pass may retire into its operator's unassigned bucket. */
export function foldsIntoBucket(agent) {
  return agent.status === "anonymous" && !keyedOnARepository(agent) && namesOnlyARun(agent.repo_root);
}

async function main() {
  // Only anonymous rows. Naming an agent registers it in the same write, so
  // `registered` means a member chose that name - not ours to revisit, even on
  // a row keyed this way.
  const candidates = await sql`
    select id, organization_id, owner_user_id, source, repo_root, repo_key, name, status
    from agents
    where repo_root is not null and status = 'anonymous'
    order by organization_id, owner_user_id, source, id
  `;
  const runNamed = candidates.filter(foldsIntoBucket);
  // A name in angle brackets is a placeholder, never a model: `like '<%>'`
  // mirrors `attestedModel` in apps/api/src/services/agent-sessions.ts exactly.
  const [placeholders] = await sql`
    select count(*)::int as count from agent_sessions where model like '<%>'
  `;

  // Bucket shifts whose own commit evidence could re-home them, counted for
  // the dry run by the first commit's repo root.
  const preview = await sql`
    select first_commit.repo_root
    from agent_sessions s
    join agents a on a.organization_id = s.organization_id and a.id = s.agent_id
    cross join lateral (
      select c.repo_root
      from shift_commits c
      where c.organization_id = s.organization_id and c.agent_session_id = s.id
      order by c.authored_at, c.id
      limit 1
    ) first_commit
    where a.repo_key is null and a.status <> 'retired'
      and s.source <> 'browser'
  `;
  const homableCount = preview.filter((shift) => repoLabel(shift.repo_root) !== null).length;

  if (runNamed.length === 0) {
    console.log("No agent is named after a run.");
  } else {
    console.log(`${runNamed.length} agent(s) named after a run:`);
    for (const agent of runNamed) console.log(`  ${agent.name}  (${agent.id})`);
  }
  console.log(`${placeholders.count} shift(s) store a placeholder where a model should be.`);
  console.log(`${homableCount} bucket shift(s) carry a commit that names a codebase.`);

  if (runNamed.length === 0 && placeholders.count === 0 && homableCount === 0) {
    console.log("Nothing to repair.");
    await sql.end();
    return;
  }

  if (!confirm) {
    console.log("\nDry run. Pass --confirm to fold the agents into their operator's unassigned bucket, clear the placeholder models, and re-home the bucket shifts counted above onto the codebase their first commit names.");
    await sql.end();
    return;
  }

  let merged = 0;
  let movedShifts = 0;
  let movedCommits = 0;
  let heldCommits = 0;
  for (const loser of runNamed) {
    await sql.begin(async (tx) => {
      // The operator's unassigned bucket for this runtime, minted if this is
      // the first shift to need it. Since 0016 the bucket is the row whose
      // `repo_key` is null, not the one whose root is, and the arbiter has to
      // restate that index's predicate exactly or postgres finds no arbiter
      // at all and the fold aborts on its first row.
      const name = `${loser.name.split(" @ ")[0]} @ unassigned`;
      const [winner] = await tx`
        insert into agents (organization_id, owner_user_id, source, repo_root, repo_key, name)
        values (${loser.organization_id}, ${loser.owner_user_id}, ${loser.source}, null, null, ${name})
        on conflict (organization_id, owner_user_id, source)
          where repo_key is null and status <> 'retired'
          do update set updated_at = now()
        returning id
      `;
      const shifts = await tx`
        update agent_sessions set agent_id = ${winner.id}, updated_at = now()
        where organization_id = ${loser.organization_id} and agent_id = ${loser.id}
        returning id
      `;
      movedShifts += shifts.length;
      // `shift_commits` and `agent_usage` each carry their own `agent_id`, so
      // the evidence does not follow its shift on its own: re-pointing only
      // the shift would strand every commit tally and token total on the row
      // being retired, and the merged agent would report neither.
      //
      // The commit re-point is guarded the way DrizzleAgentRepository.merge
      // guards its own: two shifts in the same worktree straddling the API
      // deploy can leave the bucket already recording a commit this row also
      // holds, and (organization, agent, repo_root, sha) is unique. A row the
      // bucket already has stays where it is - it is a duplicate sighting, not
      // a tally to lose - rather than aborting the fold mid-run.
      const commits = await tx`
        update shift_commits as loser_commits set agent_id = ${winner.id}
        where loser_commits.organization_id = ${loser.organization_id}
          and loser_commits.agent_id = ${loser.id}
          and not exists (
            select 1 from shift_commits as winner_commits
            where winner_commits.organization_id = loser_commits.organization_id
              and winner_commits.agent_id = ${winner.id}
              and winner_commits.repo_root = loser_commits.repo_root
              and winner_commits.sha = loser_commits.sha
          )
        returning loser_commits.id
      `;
      movedCommits += commits.length;
      const held = await tx`
        select id from shift_commits
        where organization_id = ${loser.organization_id} and agent_id = ${loser.id}
      `;
      heldCommits += held.length;
      // `agent_usage` needs no such guard: its bucket unique is keyed on
      // agent_session_id, which does not move, so re-pointing cannot collide.
      await tx`
        update agent_usage set agent_id = ${winner.id}
        where organization_id = ${loser.organization_id} and agent_id = ${loser.id}
      `;
      await tx`
        update agents set status = 'retired', updated_at = now()
        where organization_id = ${loser.organization_id} and id = ${loser.id}
      `;
      merged += 1;
    });
  }

  // Pass three: bucket shifts whose own commit evidence names a codebase.
  // The match is by label, not path, because worktree clones of one repo sit
  // at different paths; two clones already read as one codebase everywhere
  // labels render.
  //
  // This repeats the preview's join on purpose - do not fold the two into one
  // read. The predicate selects shifts whose agent is a bucket *now*, and pass
  // one has just moved a run-named agent's shifts onto exactly such a bucket:
  // a shift that probed into a gate worktree but committed in a real checkout
  // only becomes re-homable once the fold has run. Reading this list before
  // pass one silently drops every shift pass one moved.
  const bucketShifts = await sql`
    select s.id, s.organization_id, s.user_id, s.source, first_commit.repo_root
    from agent_sessions s
    join agents a on a.organization_id = s.organization_id and a.id = s.agent_id
    cross join lateral (
      select c.repo_root
      from shift_commits c
      where c.organization_id = s.organization_id and c.agent_session_id = s.id
      order by c.authored_at, c.id
      limit 1
    ) first_commit
    where a.repo_key is null and a.status <> 'retired'
      and s.source <> 'browser'
    order by s.organization_id, s.user_id, s.source, s.started_at
  `;
  const homable = bucketShifts.filter((shift) => repoLabel(shift.repo_root) !== null);
  let rehomed = 0;
  let heldRehomedCommits = 0;
  for (const shift of homable) {
    const label = repoLabel(shift.repo_root);
    await sql.begin(async (tx) => {
      const candidates = await tx`
        select id, repo_root, repo_key from agents
        where organization_id = ${shift.organization_id}
          and owner_user_id = ${shift.user_id}
          and source = ${shift.source}
          and repo_key is not null and status <> 'retired'
        order by created_at, id
      `;
      let target = findCodebaseRow(candidates, label);
      if (target === undefined) {
        const runtime = runtimeLabels.get(shift.source) ?? shift.source;
        // `agents_name_length_valid` caps a name at 200 characters, and a
        // directory name is not bounded by anything: clamp rather than let a
        // long checkout abort the whole re-homing transaction.
        const name = `${runtime} @ ${label}`.slice(0, 200);
        // A commit names a directory and nothing else, so the key this can
        // mint is the path lane's, composed exactly as `identityRepoKey`
        // composes it: 'path:' and the root verbatim. Leaving it null would
        // mint a row with a codebase and no identity - one that satisfies the
        // *unassigned* partial unique and renders "@ unassigned".
        const [minted] = await tx`
          insert into agents (organization_id, owner_user_id, source, repo_root, repo_key, name)
          values (${shift.organization_id}, ${shift.user_id}, ${shift.source}, ${shift.repo_root}, ${`path:${shift.repo_root}`}, ${name})
          on conflict (organization_id, owner_user_id, source, repo_key)
            where repo_key is not null and status <> 'retired'
            do update set updated_at = now()
          returning id
        `;
        target = minted;
      }
      await tx`
        update agent_sessions set agent_id = ${target.id}, updated_at = now()
        where organization_id = ${shift.organization_id} and id = ${shift.id}
      `;
      // Guarded and counted exactly as the fold's re-point is: a sha the
      // codebase's agent already records for this repository is a duplicate
      // sighting, so it stays where it is rather than aborting the move. Held
      // that way it outlives its own shift, though - the bucket keeps a commit
      // for a shift it no longer owns - so the tally is reported, never dropped.
      await tx`
        update shift_commits as moved set agent_id = ${target.id}
        where moved.organization_id = ${shift.organization_id}
          and moved.agent_session_id = ${shift.id}
          and not exists (
            select 1 from shift_commits as kept
            where kept.organization_id = moved.organization_id
              and kept.agent_id = ${target.id}
              and kept.repo_root = moved.repo_root
              and kept.sha = moved.sha
          )
      `;
      const heldBack = await tx`
        select id from shift_commits
        where organization_id = ${shift.organization_id} and agent_session_id = ${shift.id}
          and agent_id <> ${target.id}
      `;
      heldRehomedCommits += heldBack.length;
      await tx`
        update agent_usage set agent_id = ${target.id}
        where organization_id = ${shift.organization_id} and agent_session_id = ${shift.id}
      `;
      rehomed += 1;
    });
  }

  const repairedModels = await sql`
    update agent_sessions set model = null, updated_at = now()
    where model like '<%>'
    returning id
  `;

  console.log(`\nFolded ${merged} agent(s) in, carrying ${movedShifts} shift(s) and ${movedCommits} commit(s). No evidence row was deleted.`);
  if (heldCommits > 0) {
    console.log(`${heldCommits} commit(s) stayed on a retired row: the bucket already records that sha for the same repository.`);
  }
  console.log(`Cleared the placeholder model on ${repairedModels.length} shift(s).`);
  console.log(`Re-homed ${rehomed} bucket shift(s) onto the codebase their first commit names.`);
  if (heldRehomedCommits > 0) {
    console.log(`${heldRehomedCommits} commit(s) stayed on their bucket row: the codebase's agent already records that sha for the same repository.`);
  }

  // The verification step, run for you: no anonymous agent may still be keyed
  // on a directory that names only a run. Renamed rows are excluded on
  // purpose - they were never candidates - and counted separately so the
  // number is never mistaken for work left undone.
  const remaining = await sql`
    select repo_root, repo_key, status from agents where repo_root is not null and status <> 'retired'
  `;
  const stillKeyed = remaining.filter((agent) => !keyedOnARepository(agent) && namesOnlyARun(agent.repo_root));
  const anonymous = stillKeyed.filter((agent) => agent.status === "anonymous").length;
  console.log(`Anonymous agents still keyed on a run directory: ${anonymous}`);
  if (stillKeyed.length > anonymous) {
    console.log(`Left alone because a member named them: ${stillKeyed.length - anonymous}`);
  }
  await sql.end();
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("repair-run-named-agents.mjs")) {
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
