#!/usr/bin/env node
/**
 * Deletes seeded/test data from the Clock-In database. Dry run by default:
 * prints exactly what would go and exits. Pass --confirm to perform it.
 *
 *   DATABASE_URL=postgres://... node scripts/cleanup-test-data.mjs [--confirm] [--before=YYYY-MM-DD]
 *
 * What counts as test data, explicitly:
 *  - Whole workspaces whose every member's email matches a synthetic pattern
 *    (@clock-in.test, @siqstack-test.dev, or a +digits probe address).
 *  - In the remaining workspaces, sessions/segments/agent sessions started
 *    before --before (default: today, local midnight), plus projects whose
 *    name starts with "E2E" once nothing references them.
 * Nothing here touches rows newer than the boundary, and the default project
 * is never deleted. There are no denormalized aggregates to recompute; every
 * total is derived from these tables at read time.
 */
import process from "node:process";

import postgres from "postgres";

const confirm = process.argv.includes("--confirm");
const beforeArgument = process.argv.find((argument) => argument.startsWith("--before="));
const boundary = beforeArgument === undefined
  ? new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())
  : new Date(`${beforeArgument.split("=")[1]}T00:00:00`);
if (Number.isNaN(boundary.getTime())) {
  console.error("Invalid --before date.");
  process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") {
  console.error("Set DATABASE_URL to the database to clean.");
  process.exit(2);
}

const sql = postgres(databaseUrl, { max: 1 });
const syntheticEmail = "%@clock-in.test";

const run = async () => {
  const testOrgs = await sql`
    select o.id, o.name,
      (select count(*) from time_sessions t where t.organization_id = o.id) as sessions,
      (select string_agg(u.email, ', ') from users u where u.organization_id = o.id) as emails
    from organizations o
    where not exists (
      select 1 from users u where u.organization_id = o.id
        and u.email not like ${syntheticEmail}
        and u.email not like '%@siqstack-test.dev'
        and u.email !~ '\\+[0-9]{6,}@'
    )`;

  const staleRows = await sql`
    select o.id, o.name,
      count(*) filter (where t.started_at < ${boundary}) as stale_sessions,
      coalesce(sum(t.duration_seconds) filter (where t.started_at < ${boundary}), 0) as stale_seconds
    from organizations o join time_sessions t on t.organization_id = o.id
    where o.id not in ${testOrgs.length === 0 ? sql`(select null::uuid)` : sql`${sql(testOrgs.map((org) => org.id))}`}
    group by o.id, o.name having count(*) filter (where t.started_at < ${boundary}) > 0`;

  const e2eProjects = await sql`
    select p.id, p.name from projects p
    where p.name like 'E2E%' and p.is_default = false`;

  console.log(`Boundary: rows started before ${boundary.toISOString()}`);
  console.log(`\nWhole test workspaces (${testOrgs.length}):`);
  for (const org of testOrgs) console.log(`  ${org.name} — ${org.sessions} sessions — ${org.emails ?? "no users"}`);
  console.log(`\nStale rows in kept workspaces (${staleRows.length}):`);
  for (const row of staleRows) console.log(`  ${row.name} — ${row.stale_sessions} sessions / ${Math.round(row.stale_seconds / 60)} min before boundary`);
  console.log(`\nE2E projects (${e2eProjects.length}):`);
  for (const project of e2eProjects) console.log(`  ${project.name} (${project.id})`);

  if (!confirm) {
    console.log("\nDry run only. Re-run with --confirm to delete the rows above.");
    return;
  }

  await sql.begin(async (tx) => {
    const doomed = testOrgs.map((org) => org.id);
    if (doomed.length > 0) {
      for (const table of ["agent_sessions", "activity_segments", "time_sessions", "user_view_preferences",
        "user_project_selections", "project_path_mappings", "project_memberships", "organization_admin_claims",
        "projects", "users"]) {
        await tx`delete from ${tx(table)} where organization_id in ${tx(doomed)}`;
      }
      await tx`delete from organizations where id in ${tx(doomed)}`;
    }
    await tx`delete from agent_sessions where started_at < ${boundary}`;
    await tx`delete from activity_segments where started_at < ${boundary}`;
    await tx`delete from time_sessions where started_at < ${boundary}`;
    const projectIds = e2eProjects.map((project) => project.id);
    if (projectIds.length > 0) {
      // An E2E project still referenced by kept sessions stays; deleting it
      // would break rows the boundary chose to keep.
      const referenced = await tx`select distinct project_id from time_sessions where project_id in ${tx(projectIds)}`;
      const removable = projectIds.filter((id) => !referenced.some((row) => row.project_id === id));
      if (removable.length > 0) {
        await tx`delete from user_project_selections where project_id in ${tx(removable)}`;
        await tx`delete from project_path_mappings where project_id in ${tx(removable)}`;
        await tx`delete from project_memberships where project_id in ${tx(removable)}`;
        await tx`delete from projects where id in ${tx(removable)}`;
      }
    }
  });
  console.log("\nDeleted.");
};

run().then(
  () => sql.end(),
  (error) => {
    console.error(error);
    return sql.end().then(() => process.exit(1));
  },
);
