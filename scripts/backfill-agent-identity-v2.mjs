#!/usr/bin/env node
/**
 * Re-attributes agent shifts onto identity-v2 rows. Dry run by default:
 * prints exactly what would move and exits. Pass --confirm to perform it.
 *
 *   DATABASE_URL=postgres://... node scripts/backfill-agent-identity-v2.mjs [--confirm] [--include-unstamped]
 *
 * Identity v2 keys an agent on (organization, owner, source, repo_root)
 * instead of (organization, source, project). Rows minted under the old key
 * carry another member's shifts - whoever minted first owned the identity -
 * so this moves each shift onto the identity its own operator and codebase
 * name.
 *
 * Nothing here deletes an evidence row. A shift is re-stamped and its
 * `shift_commits` and `agent_usage` rows follow it (both key evidence by
 * `agent_session_id`, so each is one indexed update). The old agent rows keep
 * their history and stay as audit trail.
 *
 * Two passes, the second opt-in:
 *  - Shifts stamped onto a v1-keyed agent - the retired originals, and any row
 *    minted before the v2 API deployed, including one re-minted in the window
 *    between retiring and deploying. Operator is the shift's own user; the
 *    codebase is its own commit's repo root when it has one, else null.
 *  - With --include-unstamped, roster-eligible shifts that never got an
 *    identity at all (source <> 'browser'), minted and stamped under their
 *    own owner's v2 identity.
 *
 * Run it after the migration and after the new API is deployed, never before:
 * the old API keeps minting v1-keyed rows until it is replaced.
 *
 * **Historical.** This belongs to the 0015 identity-v2 sequence and its job is
 * done. `0016_agent_identity_by_remote` moved identity onto `agents.repo_key`,
 * dropped the repo-root unique this script's ON CONFLICT arbitrates on, and
 * rewrote the unassigned unique's predicate, so every insert here would now
 * either fail to find an arbiter or mint a row with a codebase and no key. Its
 * misattribution test is inverted too: it compares a commit's repo root
 * against the agent's, which after 0016 flags every shift committed from a
 * second worktree of a correctly keyed row. So it refuses a 0016 database
 * outright rather than being taught the new key -
 * scripts/repair-agent-identity-by-remote.mjs supersedes it.
 */
import process from "node:process";

import postgres from "postgres";

const confirm = process.argv.includes("--confirm");
const includeUnstamped = process.argv.includes("--include-unstamped");
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

/** The runtime labels the default name composes from, mirroring the roster. */
const runtimeLabels = new Map([
  ["claude_code", "Claude Code"],
  ["codex", "Codex"],
  ["cursor", "Cursor"],
  ["copilot", "Copilot"],
  ["kimi_code", "Kimi Code"],
  ["opencode", "opencode"],
  ["grok", "Grok"],
  ["muse", "Muse"],
  ["pi", "Pi"],
]);

/** The last path segment of a repo root; a name, never a path. */
const repoLabel = (path) => {
  if (path === null) return null;
  const segments = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  const last = segments[segments.length - 1] ?? "";
  return last === "" ? null : last.slice(0, 200);
};

const defaultName = (source, repoRoot) =>
  `${runtimeLabels.get(source) ?? source} @ ${repoLabel(repoRoot) ?? "unassigned"}`;

/**
 * A shift's v2 identity, found or minted. The insert restates both partial
 * uniques' predicates in its ON CONFLICT, exactly as the API's upsert does.
 */
async function identityFor(tx, { organizationId, ownerUserId, source, repoRoot }) {
  const name = defaultName(source, repoRoot);
  const rows = repoRoot === null
    ? await tx`
        insert into agents (organization_id, owner_user_id, source, repo_root, name)
        values (${organizationId}, ${ownerUserId}, ${source}, null, ${name})
        on conflict (organization_id, owner_user_id, source)
          where repo_root is null and status <> 'retired'
          do update set updated_at = now()
        returning id
      `
    : await tx`
        insert into agents (organization_id, owner_user_id, source, repo_root, name)
        values (${organizationId}, ${ownerUserId}, ${source}, ${repoRoot}, ${name})
        on conflict (organization_id, owner_user_id, source, repo_root)
          where repo_root is not null and status <> 'retired'
          do update set updated_at = now()
        returning id
      `;
  return rows[0].id;
}

/**
 * Shifts to move, with the operator and codebase their v2 identity is keyed
 * on. A v1-keyed agent is one with no repo_root that some other member's
 * shifts are stamped onto, or any agent whose shifts name an operator it does
 * not belong to - which is exactly the production symptom.
 */
async function stampedOntoV1Rows() {
  return sql`
    select
      s.id as session_id,
      s.organization_id,
      s.user_id,
      s.source,
      s.agent_id as current_agent_id,
      a.owner_user_id as current_owner_id,
      a.repo_root as current_repo_root,
      (select c.repo_root from shift_commits c
        where c.organization_id = s.organization_id and c.agent_session_id = s.id
        order by c.authored_at limit 1) as evidence_repo_root
    from agent_sessions s
    join agents a on a.organization_id = s.organization_id and a.id = s.agent_id
    where s.source <> 'browser'
    order by s.started_at
  `;
}

async function unstampedShifts() {
  return sql`
    select s.id as session_id, s.organization_id, s.user_id, s.source,
      (select c.repo_root from shift_commits c
        where c.organization_id = s.organization_id and c.agent_session_id = s.id
        order by c.authored_at limit 1) as evidence_repo_root
    from agent_sessions s
    where s.agent_id is null and s.source <> 'browser'
    order by s.started_at
  `;
}

/** Moves one shift and the evidence keyed to it, overwriting the stamp. */
async function restamp(tx, session, agentId) {
  await tx`update agent_sessions set agent_id = ${agentId}, updated_at = now()
    where organization_id = ${session.organization_id} and id = ${session.session_id}`;
  await tx`update shift_commits set agent_id = ${agentId}, updated_at = now()
    where organization_id = ${session.organization_id} and agent_session_id = ${session.session_id}`;
  await tx`update agent_usage set agent_id = ${agentId}, updated_at = now()
    where organization_id = ${session.organization_id} and agent_session_id = ${session.session_id}`;
}

/**
 * Refuses a database that has moved past this script's identity model.
 *
 * `agents.repo_key` exists only from `0016_agent_identity_by_remote` onward,
 * and that migration invalidated every write below. Running this against such
 * a database with `--confirm` would abort on a missing arbiter at best and
 * mint keyless repo-keyed rows at worst, so the column's presence is the
 * refusal: this script's window has closed.
 */
async function requirePreRemoteSchema() {
  const [found] = await sql`
    select exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'agents' and column_name = 'repo_key'
    ) as has_repo_key
  `;
  if (found.has_repo_key) {
    console.error("`agents` carries `repo_key`, so this database is on 0016_agent_identity_by_remote or later.");
    console.error("This script belongs to the 0015 identity-v2 sequence and its writes are invalid against that schema.");
    console.error("Use scripts/repair-agent-identity-by-remote.mjs, which supersedes it.");
    await sql.end();
    process.exit(2);
  }
}

async function main() {
  await requirePreRemoteSchema();
  const stamped = await stampedOntoV1Rows();
  // A shift needs moving when its current identity does not name its own
  // operator, or when its commit evidence names a different codebase. A shift
  // with no commit evidence keeps whatever codebase its identity already
  // carries - a graduation or a probe set it, and absent evidence is not a
  // contradiction - so a late or repeat run never demotes it to unassigned.
  const misattributed = stamped.filter((row) => {
    if (row.current_owner_id !== row.user_id) return true;
    const evidence = row.evidence_repo_root ?? null;
    return evidence !== null && evidence !== (row.current_repo_root ?? null);
  });
  const unstamped = includeUnstamped ? await unstampedShifts() : [];

  const wrongOperator = misattributed.filter((row) => row.current_owner_id !== row.user_id).length;
  console.log(`Shifts stamped onto an identity that is not their operator's: ${wrongOperator}`);
  console.log(`Shifts whose codebase does not match their identity's: ${misattributed.length - wrongOperator}`);
  console.log(`Shifts to re-attribute: ${misattributed.length}`);
  if (includeUnstamped) {
    console.log(`Roster-eligible shifts with no identity at all: ${unstamped.length}`);
  } else {
    console.log("Shifts with no identity at all are skipped; pass --include-unstamped to move them too.");
  }

  if (!confirm) {
    console.log("\nDry run. Nothing was written. Re-run with --confirm to perform it.");
    await sql.end();
    return;
  }

  let moved = 0;
  for (const session of [...misattributed, ...unstamped]) {
    await sql.begin(async (tx) => {
      const agentId = await identityFor(tx, {
        organizationId: session.organization_id,
        ownerUserId: session.user_id,
        source: session.source,
        repoRoot: session.evidence_repo_root ?? null,
      });
      await restamp(tx, session, agentId);
    });
    moved += 1;
  }
  console.log(`\nRe-attributed ${moved} shift(s). No evidence row was deleted.`);

  // The verification step, run for you: nothing may still reference an agent
  // whose owner is not the shift's own operator.
  const [remaining] = await sql`
    select count(*)::int as count
    from agent_sessions s
    join agents a on a.organization_id = s.organization_id and a.id = s.agent_id
    where s.source <> 'browser' and a.owner_user_id <> s.user_id
  `;
  console.log(`Shifts still stamped onto another member's identity: ${remaining.count}`);
  await sql.end();
}

main().catch(async (error) => {
  console.error(error);
  await sql.end({ timeout: 5 });
  process.exit(1);
});
