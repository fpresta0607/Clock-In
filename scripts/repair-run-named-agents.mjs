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
 * Each run-named agent merges into the one unassigned agent for its
 * (organization, owner, source): shifts, `shift_commits` and `agent_usage`
 * follow, then the emptied row is retired. Nothing is deleted, and an agent a
 * member has renamed is left alone - a name someone chose is not ours to
 * revisit, even on a row keyed this way.
 *
 * It also re-homes bucket shifts whose working directory names a codebase.
 * A hook older than the repo probe reported no repo root at all, so every
 * shift minted into its operator's unassigned bucket even when its cwd was a
 * real checkout - a treehouse worktree launches at the worktree root. Each
 * such shift moves onto the codebase its own cwd names: an existing agent of
 * the same (organization, owner, source) whose repo root carries the same
 * label when there is one, else a fresh identity keyed on the shift's cwd.
 * A cwd whose last segment is opaque stays put - it names only a run.
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

const confirm = process.argv.includes("--confirm");
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

/**
 * Mirrors `OPAQUE_SEGMENT` in apps/api/src/services/attribution.ts: a ULID, a
 * UUID, or a bare hex hash names no codebase to anyone. Keep the two identical
 * - the ULID branch is uppercase-only there for the same reason it is here, so
 * a lowercase 26-character codebase name is never folded away. The hex branch
 * cannot be uppercase-only (git SHAs are lowercase), so it is keyed on length
 * instead: exactly a full SHA-1 (40) or SHA-256 (64) hex string.
 */
/** The declared runtimes' display names, from the one roster both sides read. */
const runtimeLabels = new Map(registry.runtimes.map((runtime) => [runtime.id, runtime.label]));

const OPAQUE_SEGMENT =
  /^(?:[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

const lastSegment = (path) => {
  const segments = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return segments[segments.length - 1] ?? "";
};

const namesOnlyARun = (repoRoot) =>
  repoRoot !== null && OPAQUE_SEGMENT.test(lastSegment(repoRoot));

async function main() {
  // Only anonymous rows. Naming an agent registers it in the same write, so
  // `registered` means a member chose that name - not ours to revisit, even on
  // a row keyed this way.
  const candidates = await sql`
    select id, organization_id, owner_user_id, source, repo_root, name, status
    from agents
    where repo_root is not null and status = 'anonymous'
    order by organization_id, owner_user_id, source, id
  `;
  const runNamed = candidates.filter((agent) => namesOnlyARun(agent.repo_root));
  // A name in angle brackets is a placeholder, never a model: `like '<%>'`
  // mirrors `attestedModel` in apps/api/src/services/agent-sessions.ts exactly.
  const [placeholders] = await sql`
    select count(*)::int as count from agent_sessions where model like '<%>'
  `;

  // Bucket shifts a cwd could re-home, counted for the dry run by label.
  const preview = await sql`
    select s.cwd
    from agent_sessions s
    join agents a on a.organization_id = s.organization_id and a.id = s.agent_id
    where a.repo_root is null and a.status <> 'retired'
      and s.cwd is not null and s.source <> 'browser'
  `;
  const homableCount = preview.filter((shift) => {
    const label = lastSegment(shift.cwd);
    return label !== "" && !OPAQUE_SEGMENT.test(label);
  }).length;

  if (runNamed.length === 0) {
    console.log("No agent is named after a run.");
  } else {
    console.log(`${runNamed.length} agent(s) named after a run:`);
    for (const agent of runNamed) console.log(`  ${agent.name}  (${agent.id})`);
  }
  console.log(`${placeholders.count} shift(s) store a placeholder where a model should be.`);
  console.log(`${homableCount} bucket shift(s) recorded a cwd that names a codebase.`);

  if (runNamed.length === 0 && placeholders.count === 0 && homableCount === 0) {
    console.log("Nothing to repair.");
    await sql.end();
    return;
  }

  if (!confirm) {
    console.log("\nDry run. Pass --confirm to fold the agents into their operator's unassigned bucket and clear the placeholder models.");
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
      // the first shift to need it. The partial unique excludes retired rows,
      // so the arbiter restates that predicate exactly.
      const name = `${loser.name.split(" @ ")[0]} @ unassigned`;
      const [winner] = await tx`
        insert into agents (organization_id, owner_user_id, source, repo_root, name)
        values (${loser.organization_id}, ${loser.owner_user_id}, ${loser.source}, null, ${name})
        on conflict (organization_id, owner_user_id, source)
          where repo_root is null and status <> 'retired'
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

  // Pass three: bucket shifts whose own cwd names a codebase. The join is by
  // label, not path, because worktree clones of one repo sit at different
  // paths; two clones already read as one codebase everywhere labels render.
  const bucketShifts = await sql`
    select s.id, s.organization_id, s.user_id, s.source, s.cwd, s.agent_id
    from agent_sessions s
    join agents a on a.organization_id = s.organization_id and a.id = s.agent_id
    where a.repo_root is null and a.status <> 'retired'
      and s.cwd is not null and s.source <> 'browser'
    order by s.organization_id, s.user_id, s.source, s.started_at
  `;
  const homable = bucketShifts.filter((shift) => {
    const label = lastSegment(shift.cwd);
    return label !== "" && !OPAQUE_SEGMENT.test(label);
  });
  let rehomed = 0;
  for (const shift of homable) {
    const label = lastSegment(shift.cwd);
    await sql.begin(async (tx) => {
      const candidates = await tx`
        select id, repo_root from agents
        where organization_id = ${shift.organization_id}
          and owner_user_id = ${shift.user_id}
          and source = ${shift.source}
          and repo_root is not null and status <> 'retired'
        order by created_at, id
      `;
      // Oldest matching label wins, deterministically; the label is what
      // every surface renders, so which clone's row carries the shift does
      // not change what anyone reads.
      let target = candidates.find((agent) => lastSegment(agent.repo_root) === label);
      if (target === undefined) {
        const runtime = runtimeLabels.get(shift.source) ?? shift.source;
        const [minted] = await tx`
          insert into agents (organization_id, owner_user_id, source, repo_root, name)
          values (${shift.organization_id}, ${shift.user_id}, ${shift.source}, ${shift.cwd}, ${`${runtime} @ ${label}`})
          on conflict (organization_id, owner_user_id, source, repo_root)
            where repo_root is not null and status <> 'retired'
            do update set updated_at = now()
          returning id
        `;
        target = minted;
      }
      await tx`
        update agent_sessions set agent_id = ${target.id}, updated_at = now()
        where organization_id = ${shift.organization_id} and id = ${shift.id}
      `;
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
  console.log(`Re-homed ${rehomed} bucket shift(s) onto the codebase their cwd names.`);

  // The verification step, run for you: no anonymous agent may still be keyed
  // on a directory that names only a run. Renamed rows are excluded on
  // purpose - they were never candidates - and counted separately so the
  // number is never mistaken for work left undone.
  const remaining = await sql`
    select repo_root, status from agents where repo_root is not null and status <> 'retired'
  `;
  const stillKeyed = remaining.filter((agent) => namesOnlyARun(agent.repo_root));
  const anonymous = stillKeyed.filter((agent) => agent.status === "anonymous").length;
  console.log(`Anonymous agents still keyed on a run directory: ${anonymous}`);
  if (stillKeyed.length > anonymous) {
    console.log(`Left alone because a member named them: ${stillKeyed.length - anonymous}`);
  }
  await sql.end();
}

main().catch(async (error) => {
  console.error(error);
  await sql.end({ timeout: 5 });
  process.exit(1);
});
