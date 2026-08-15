# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## The product model, so you don't restore a dead one

**There is no manual timer.** Recording is automatic: the OS monitor's own
working/idle/locked/suspended boundaries open and close sessions, and the consent
toggle (`MonitorSettings.enabled`, on by default) is the product's only on/off.
Anything that reads like start/stop, an away prompt, a suggested start, or a
running-timer conflict belongs to the retired model. `POST /sessions`,
`/sessions/:id/stop`, and `/sessions/current` still exist but are deprecated and
called by nothing shipped; the live write path is `POST /sessions/observed`.
Legacy rows keep `attribution = 'manual'` and are never rewritten.

Reporting measures **active time** (the union of a person's working intervals — the
leaderboard headline, never exceeding wall clock), **agent time** (the summed agent
runtime, so parallel agents legitimately exceed active time), and **leverage**
(agent ÷ active); concurrency splits active time into t0/t1/t2/t3+ plus the agent
runtime that fell outside the person's presence. A session is still attributed whole
or not at all by `time_sessions.attribution`. The README's "How session tracking works"
section is the authoritative prose; keep it true when you change the model.

## The agent-runtime roster is data, not code

`packages/shared/src/agent-runtimes.json` is the single declaration of every runtime
Clock-In knows by name. The TypeScript side imports it; the Rust host embeds the same
file (`apps/desktop/src-tauri/src/agent_runtimes.rs`), so the two cannot drift. Add a
runtime there, not in six places.

It is a roster, **not an allowlist**: `agent_sessions.source` is text with a shape
check, so an undeclared runtime is still recorded under its own id. Never reintroduce
an enum for it, and never map an unknown runtime onto `other`.

A runtime is identified by the registration that fired, never by the payload's shape:
Codex pipes Claude Code's exact hook payload, so registrations pass `--source`. And
runtime and model are independent — neither is ever derived from the other.

## What actually closes a segment

`SegmentBuilder::apply` is the whole capture path, and three things end an
active span: a change of state, a change of the app in front, and
`MAX_OPEN_ACTIVE_SECONDS`. Only the first existed once, and it is why
`activity_segments` was empty in production for the app's whole life: a machine
in continuous use never changes state, so one span sat in memory and the spool
file was never created. If you touch the fold, keep all three, and keep idle
spans **whole** - `SessionTracker` measures quiet time from the open idle span's
start, so splitting one stops sessions ever closing.

`running` means "the tasks were started"; `observing` means "polls are still
landing". A poll task that panics leaves its `JoinHandle` in place, so only
`observing` may be read as recording. `recordingState` in `RecordingPanel.tsx`
is the single derivation every surface reads, and each surface's wording comes
from a table keyed by it. Do not re-derive it locally: that is exactly how the
timer once said RECORDING above a card reading "Turn on recording in settings".

## Sharp edges

- The Rust toolchain lives at `~/.cargo/bin` and may not be on `PATH`. Rust gate:
  `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test`,
  all with `--manifest-path apps/desktop/src-tauri/Cargo.toml`.
- `build.rs` treats *any* build with `debug_assertions` off as a production artifact
  and demands the updater key plus platform signing credentials. So an unsigned
  installer is a `tauri build --debug` bundle
  (`.github/workflows/unsigned-test-installers.yml`), never a relaxed release build;
  `release.yml` fails hard on partial signing but skips (neutral) when no
  platform-signing secrets are configured — unsigned is the project's accepted
  distribution, and the workflow dispatches the unsigned installer publish instead.
  `src/release_signing.rs` stays fail-closed. Because the shipped
  installer is a *debug* build, never gate user-facing behaviour on
  `debug_assertions`: that condition is true in the artifact people download.
  `windows_subsystem` was gated that way and every install opened a console window
  behind the app.
- Desktop settings are read with `#[serde(default)]`, so removing a field is safe
  for existing installs, but *adding* one needs a sensible default or old files
  parse into something surprising.
- Migrations are generated, never hand-written: change `packages/database/src/schema.ts`,
  then `pnpm exec drizzle-kit generate --name <slug>` from `packages/database`. The
  snapshots under `migrations/meta` had drifted ahead of the SQL files, so a database
  built only from `migrations/*.sql` did not match `schema.ts` and `generate` - which
  diffs against the newest snapshot, never against a real database - could not see it.
  `0012_path_mapping_kind` closed the last of that drift, and CI now replays the whole
  chain against a PostgreSQL service container, which is what keeps it closed. Still read
  the emitted SQL before assuming it is only your change.
- The held rate is client-attested by design: `POST /shift-commits` records the desktop
  app's `verification` and `verified_at` as given and nothing corroborates them
  server-side (the plan below lists GitHub App/webhooks as a dead model). It is evidence
  about the work from the machine that did the work, so every surface saying "held"
  labels it that way - the paystub metric and README's roster section. Do not let it
  quietly become an input to pay without revisiting that decision.
- A repo root is a working directory, so the paystub sends `shiftCommitViewSchema.repoRoot`
  only to the agent's owner and workspace admins and omits it for everyone else
  (`services/agents.ts`). The disclosure sentence naming what leaves the machine is
  stated in `apps/web/src/HelpModal.tsx`, `apps/desktop/src/RecordingPanel.tsx`
  and README's "What is never collected"; the three word it differently, but they must
  all describe the same thing that actually leaves the machine, so change what is sent
  and all three change with it.
- The migration folder is not a description of production. Production's
  `drizzle.__drizzle_migrations` holds entries whose hashes match no file on `main`,
  because phase 3 applied migrations that were later rewritten here. Drizzle selects
  work by `created_at` alone and never verifies a hash, so the chain replays onto a
  schema it was not generated against and stops on the first collision. Dry-run against
  a replica built from production's journal before migrating it; see "Production's
  migration journal has entries this repo no longer carries" in `DEPLOY.md`. Nothing
  migrates on deploy, so this is always a deliberate, separate step.
- `clock-in-hook` and the desktop uploader must resolve the spool through the same
  `spool::agent_spool_path()`. When they disagreed, the hook exited 0, wrote nothing
  the uploader could see, and every agent event vanished silently. The browser host
  and the app share the same rule for `spool::browser_dir()`, so the two cannot
  drift apart the same way.
- The desktop force-installs the browser extension via the HKCU
  `ExtensionInstallForcelist` policy (`browser::sync_extension_policies`), but only
  when the store ids are compiled in (`CLOCK_IN_CHROME_EXTENSION_ID` /
  `CLOCK_IN_EDGE_EXTENSION_ID` repo vars), so nothing happens until the extension is
  published and the vars are set. `MonitorSettings.browser_auto_install` (default on)
  is the opt-out: removing the policy entry is what uninstalls the extension. Firefox
  has no force-install path until an AMO listing exists and keeps the manual flow.
- The site's **Download for Windows** button is a hard-coded
  `releases/download/unsigned-latest/<fixed asset name>` URL, kept true by the `publish`
  job in `unsigned-test-installers.yml`. That job runs on `workflow_dispatch` only, so a
  `unsigned-test/**` push builds without touching what the public downloads. Rename an
  asset on one side alone and the button 404s silently; `DownloadInstaller.test.tsx` pins
  both names. Never link a workflow-run artifact publicly: downloading one needs auth.
  The app version lives only in `apps/desktop/src-tauri/tauri.conf.json` and nothing bumps
  it for you, so a fresh build will introduce itself as the last version you shipped.
- Both frontends share `packages/shared/styles/brand.css` and ship a single dark
  theme; there is no light theme to match, so use the tokens rather than literals.
- Nothing deploys on merge. The API (Railway) and the web dashboard (Vercel) are
  separate manual pushes, so production can run two different commits of
  `packages/shared`. Because the report filters are `.strict()`, a newer web
  bundle sending a parameter an older API does not declare gets a bare `400`.
  Check what is deployed before debugging a live report failure; see
  "Deploy the API and the web dashboard together" in `DEPLOY.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

Disambiguation: the agent-runtimes.json roster is runtime declarations; the `agents` table is worker identities.

# Roster v1 - implementation plan

## Context

Clock-In answers *how long*; Roster v1 makes it answer *who worked* and *whether the work held*.
Agents become durable identities keyed by **(source, project)** per org; `agent_sessions` rows are
their shifts; commits made during a shift are captured by the desktop app (read-only git) and later
verified locally (merged / reverted / orphaned). Vocabulary is payroll: roster, shift, pay period,
hours, paystub, headcount. Dead models (do not build): definition fingerprints, GitHub App/webhooks,
manual timers.

User decisions (confirmed): **full v1, all 5 build-order steps** on branch
`claude/roster-v1-master-plan-jbak2h`, one commit per step so any prefix ships alone;
**browser spans excluded** from agent minting; rename/register/retire open to **any member**,
**merge admin-only**.

Mid-turn user requests folded in (desktop): Humans|Agents **tabs** in the All-stats leaderboard
header replacing the org name (no separate roster section); **remove** the All-stats project-scope
select (redundant with the main screen's filing bar); fix the Agent-sessions table showing fake
zeros (absent API fields decoded as 0); stop "Cannot reach the server" **blips** from single failed
background polls.

Key repo facts: `CLAUDE.md` is a **symlink** to `AGENTS.md` (edit AGENTS.md only). Routes thin ->
services own rules -> repositories own SQL; services tested against fakes. Migrations are generated
(`pnpm exec drizzle-kit generate`), never hand-written, and the meta snapshots have drifted - always
inspect generated SQL for leftovers. Nothing deploys or migrates on merge (API=Railway, web=Vercel,
both manual; `.strict()` request filters mean API deploys before/with web). Rust gate:
`cargo fmt --check` / `cargo clippy --all-targets -- -D warnings` / `cargo test` with
`--manifest-path apps/desktop/src-tauri/Cargo.toml` (toolchain at `~/.cargo/bin`).

## Up-front design decisions

- **Naming collision**: code identifiers use "agents" everywhere; "roster" only in UI copy. AGENTS.md
  append gets one disambiguation sentence (agent-runtimes.json roster = runtime declarations; the
  `agents` table = worker identities).
- **Browser exclusion switch**: one predicate `rosterEligibleSource(source) => source !== "browser"`
  in `apps/api/src/services/agent-sessions.ts`.
- **Windows gate**: shift-commit capture drives from the uploader's `upload_once` pass (all
  platforms), NOT from the `#[cfg(windows)]`-gated `replay_agent_spool`.
- **Shift windows sidecar**: `Started` and `Ended` spool lines may drain in different passes, so a
  persisted `shift-windows.json` sidecar carries `started_at`/`cwd` forward.
- **Early commits**: `upload_shift_commits` runs only after both agent-spool drains succeeded that
  pass; server rejects unknown sessions with reason `"unknown_session"`, which the client treats as
  retryable (row stays unsynced). Other rejections are permanent.
- **One endpoint for capture + verification**: `POST /shift-commits` upserts on (org, user,
  clientId); verification only ever advances `pending -> merged|reverted|orphaned` (terminal);
  `verified_at` set once, never regresses; replays are accepted no-ops.
- **shift_commits dedup**: denormalized `user_id`, `agent_id` (NOT NULL), `client_id`. Uniques:
  `(org, user_id, client_id)` for replay idempotency; `(org, agent_id, repo_root, sha)` for the
  "same agent records once / different agents record each" rule.
- **agents uniqueness with nullable project**: two partial unique indexes, both excluding retired
  rows - `agents_organization_source_project_unique` over (org, source, projectId) and
  `agents_organization_source_unassigned_unique` over (org, source) where projectId is null. The
  unassigned half is its own index because drizzle `uniqueIndex` cannot express NULLS NOT DISTINCT,
  and retiring has to release the key so the next shift mints a fresh identity instead of
  resurrecting the retired one.
- **Paystub period**: `fromAt`/`toExclusiveAt` instants (client-composed like every filter), no named
  period token; trend = 6 weekly buckets computed server-side.
- **No new error codes** - validation_error / not_found / forbidden / conflict cover everything.

---

## Step 0 - append master plan to AGENTS.md

Append the Roster v1 master-plan document (from the task description) as a section of
`AGENTS.md` + the disambiguation sentence. CLAUDE.md is a symlink - do not
replace it with a regular file. Commit alone.

## Step 0.5 - desktop fixes the user asked for (independent of Roster)

All in `apps/desktop/src`:

1. **Fake zeros in Agent sessions table.** `decodeAgentSplit` (bridge.ts:659-669) uses
   `optionalNonnegativeInteger` (bridge.ts:352-355) which coerces absent `sessionCount` /
   `maxConcurrent` / `medianSeconds` to 0 - the deployed API is older and doesn't send them; the
   server (reports.ts:248-282) can never legitimately send count 0 with duration > 0. Change the
   `MeStatsAgentSplit` bridge type to `number | null` for those three fields, decode absent -> null,
   and render "-" in `AgentSessionsTable` (App.tsx:169-201) when null. Absence shown as absence.
   (Also tell the user: the Railway API needs a manual deploy to send real values.)
2. **Remove the All-stats project scope select** (App.tsx:1483-1489) plus the `boardScope` state,
   the preference-seeding effect (:570-587), and `changeBoardScope` (:1245-1249). Overlay fetches
   become unscoped (all projects); the per-project stat list below already gives detail. The web
   dashboard keeps its own scope picker and the shared preference row; the desktop simply stops
   editing it. Update the live-day-shortcut condition (:607-608) which currently checks
   `boardScope === "all"`.
3. **Error-blip tolerance.** The three background polls surface a banner on a single failed
   request: main-screen meStats (App.tsx:546-568 -> `statsError`, rendered :1369), orgOverview
   (:525-543 -> `overviewError`, :1510/:1820), All-stats board meStats (:589-632 ->
   `boardStatsError`, via `boardError` :1252). Add a consecutive-failure counter (useRef) per poll:
   keep last-good data, surface the message only after 3 consecutive failures or when there is no
   data at all; reset counter and clear error on success. User-initiated actions (join, sign-in,
   settings) keep immediate errors. Update desktop App tests accordingly.

## Step 1 - migration + agent resolution

### Schema (`packages/database/src/schema.ts`)

New table `agents` (declare above `agentSessions`, no cycle):
`id` uuid pk defaultRandom; `organizationId` uuid notNull refs organizations cascade;
`ownerUserId` uuid notNull; `projectId` uuid nullable; `source` text notNull; `name` text notNull;
`status` text `$type<"anonymous"|"registered"|"retired">()` default "anonymous" notNull;
`...auditColumns` last. Constraints (house naming):
- `unique("agents_organization_id_id_unique").on(org, id)` - composite-FK target
- `uniqueIndex("agents_organization_source_project_unique").on(org, source, projectId)` where
  status <> retired, plus `uniqueIndex("agents_organization_source_unassigned_unique").on(org, source)`
  where projectId is null and status <> retired (retiring releases the identity key - see Up-front)
- `foreignKey` `agents_organization_owner_fk` -> users(org,id) cascade; `agents_organization_project_fk`
  -> projects(org,id) restrict
- checks: `agents_status_valid` (in-list), `agents_source_valid` (same regex/length as
  agent_sessions_source_valid schema.ts:337), `agents_name_length_valid` (1..200)
- `index("agents_organization_id_idx")`

`agentSessions` gains `agentId: uuid("agent_id")` nullable (comment: legacy rows stay null, never
backfilled) + `foreignKey` `agent_sessions_organization_agent_fk` -> agents(org,id) restrict.

Barrel: re-export `agents` from `packages/database/src/index.ts`. Migration:
`pnpm exec drizzle-kit generate --name roster_agents` from packages/database, then **inspect the SQL
for drift leftovers**. Tests: new `agents` case in schema.test.ts; agent_sessions FK count 3->4 at
schema.test.ts:209 + new column.

### Repository (`apps/api/src/repositories.ts` + `drizzle-repositories.ts`)

New `AgentRepository`: `upsertForKey({org, ownerUserId, source, projectId, name, now}) -> {id}`
(insert `onConflictDoUpdate` on the (org,source,projectId) target with `set:{updatedAt}` +
`.returning({id})` so replay yields the id; never overwrites name/owner/status);
`listForOrganization`, `findById`, `update(patch)`, `merge(subject, winnerId, loserId)`
(transaction: re-point agent_sessions - and shift_commits once it exists - loser -> winner, retire
loser). `AgentSessionRecord` + `UpsertStartedAgentSession`/`InsertEndedAgentSession` gain
`agentId: string | null`; `upsertStarted` (drizzle-repositories.ts:1081-1113) conflict-set uses
`coalesce(agent_sessions.agent_id, $new)` - first assignment wins, never blanked. Export new
class/types from `apps/api/src/index.ts`.

### Resolution (`apps/api/src/services/agent-sessions.ts`)

Deps (:31-37) gain optional `agents?: AgentRepository`. Beside `loadMappings` (:79-83), add a
per-batch memo `Map<`${source}|${projectId ?? ""}`, Promise<string>>` and
`resolveAgent(source, projectId)` -> null when dep missing or `!rosterEligibleSource(source)`.
Default name composed in the repo insert path: `agentRuntimeLabel(source)` (packages/shared) +
`" @ " + (project name | "unassigned")`. Stamp `agentId` in the `started` branch (:102-121) and the
end-before-start branch (:126-138). Wiring: `CreateAppDependencies.agentRepository?`, pass in the
`/agent-sessions` block (app.ts:304-317); construct `DrizzleAgentRepository` in server.ts.

Tests: services/agent-sessions.test.ts (fake AgentRepository recording upserts: started mints,
ended-before-start mints, browser mints nothing, batch memoized to one upsert, missing dep safe);
routes/agent-sessions.test.ts fakes extended; TEST_DATABASE_URL-gated integration for the
nulls-not-distinct upsert.

## Step 2 - Agents API + web Roster tab + paystub

### Contracts (`packages/shared/src/contracts.ts`)

`agentStatusSchema`; `agentSchema` {id, name 1..200, source: agentSourceSchema, status,
owner {id,name}, project {id,name}|null, createdAt} `.strict()`; `agentsListResponseSchema`;
`agentPatchRequestSchema` {name?, status?: "registered"|"retired", ownerUserId?} `.strict()`
(+ refine non-empty); `agentMergeRequestSchema` {loserId} (path `:id` = winner);
`agentPaystubFiltersSchema` {from?, to?, fromAt?, toExclusiveAt?}
`.strict().superRefine(validateCalendarAndInstantBounds)`; `shiftCommitVerificationValues`
["pending","merged","reverted","orphaned"]; `shiftCommitViewSchema` {id, repoRoot?: string,
branch|null, sha, subject, authoredAt, verification, verifiedAt|null} - repoRoot optional, sent only
to the agent's owner and workspace admins; `agentPaystubResponseSchema` {agent,
filters, totals {agentSeconds, shiftCount, commitsRecorded/Pending/Merged/Reverted/Orphaned,
heldRate: number 0..1 | null}, shifts [{id, startedAt, endedAt|null, model|null, durationSeconds,
commits[]}], trend [{periodStartAt, agentSeconds, shiftCount, heldRate|null}]} - commit counts all
0 / heldRate null until step 3 data exists (schema ships complete so web parses one shape).

### API

New `apps/api/src/services/agents.ts` - `createAgentService({agents, reaper, shiftCommits?, clock?})`
with `list`, `patch` (load+404, re-validate merged record - template services/path-mappings.ts:77-105),
`merge` (admin gate first - template services/projects.ts:124-126; winner===loser ->
validation_error), `paystub` (reapStale first; shifts via new
`AgentRepository.listSessionsForAgent(subject, agentId, query)` - running shifts end at
coalesce(ended_at, last_event_at); group intervals per shift before summing, reports.ts:252-254
rounding rule; trend = 6 weekly buckets). New `apps/api/src/routes/agents.ts`: GET /, PATCH /:id
(uuid-parse params - routes/path-mappings.ts:59-70), POST /:id/merge, GET /:id/paystub. Mount in
app.ts with BOTH `app.use("/agents", authenticate)` and `"/agents/*"`. Export from index.ts.

### Web (`apps/web/src/client.ts`, `App.tsx`)

client.ts one-liners: `agents()`, `patchAgent`, `mergeAgents`, `agentPaystub` (+ `agentsReport` in
step 5). App.tsx: **People | Agents segmented toggle** in the leaderboard card head (:701-715),
`useState<"people"|"agents">`; People renders the existing board unchanged; Agents renders the
roster in the same `ol.board-list` / `board-choice` grammar - name, owner, source label
(`agentRuntimeLabel`), and (until step 5 data) "-" for hours/shifts/commits columns; anonymous rows
greyed (`is-anonymous`) with inline one-click **Register** (prefilled name + owner confirm ->
PATCH {status:"registered", ...}); row click swaps the detail region (:759-816 grammar) for the
**paystub**: shifts, hours, commits with verification badges, trend. Reuse `rangeQuery` (:52-59) /
`withParams` (:62-67). Brand tokens only, no color literals.

Tests: routes/agents.test.ts (MemoryAgents fake; member 403 on merge, admin merge re-points +
retires, PATCH/paystub/validation cases); services/agents.test.ts; contracts.test.ts cases;
App.test.tsx (clientFor gains new methods; tab toggle, Register PATCH, paystub fetch);
contract-compatibility.test.ts parses the exact paystub query the web emits.

## Step 3 - shift_commits capture + POST /shift-commits

### Schema (second migration `roster_shift_commits`)

`shift_commits`: id pk; organizationId; userId notNull; agentId notNull; agentSessionId notNull;
clientId notNull; repoRoot text; branch text|null (detached HEAD); sha text; subject text;
authoredAt tstz; verification text `$type<...>` default "pending"; verifiedAt tstz|null;
recordedAt defaultNow; auditColumns. Constraints:
`shift_commits_organization_user_client_unique`(org,userId,clientId);
`shift_commits_organization_agent_repo_sha_unique`(org,agentId,repoRoot,sha); composite FKs
`_organization_user_fk` cascade, `_organization_agent_fk` restrict, `_organization_session_fk`
cascade - the latter needs `unique("agent_sessions_organization_id_id_unique").on(org, id)` added
to agentSessions in this migration; checks: verification in-list, sha `^[0-9a-f]{40,64}$`,
repo_root 1..1000, subject <=500, branch null|1..500, `(verification='pending') = (verified_at is
null)`; index (org, agentId, authoredAt). Barrel + schema.test.ts cases.

### API

Contracts: `shiftCommitUploadSchema` {clientId, source: agentSourceSchema, externalSessionId,
repoRoot, branch?, sha, subject <=500, authoredAt, verification, verifiedAt?} `.strict()`;
batch request {commits: array 1..500}; response {accepted, rejected:[{clientId, reason}]}
(activity template contracts.ts:402-425); reason `"unknown_session"` documented as retryable.

`ShiftCommitRepository`: `findByClientId`, `insert -> "inserted"|"duplicate"` (onConflictDoNothing,
no target - either unique absorbs), `advanceVerification` (guarded `where verification='pending'`),
`countsByAgent(subject, query)`, `listForAgent`. New `apps/api/src/services/shift-commits.ts`
processed row-by-row: resolve session via `agentSessions.findByExternalKey(subject, source,
externalSessionId)` (memoized per batch); missing -> rejected "unknown_session"; session with null
agentId + roster-eligible source -> upsert agent + new `AgentSessionRepository.stampAgent` (so
pre-feature sessions ending after deploy still take commits); clientId hit -> replay (advance
verification if pending->decided, else accepted no-op); miss -> insert ("duplicate" = accepted
no-op). Reject rows whose verifiedAt presence disagrees with verification. New route
`apps/api/src/routes/shift-commits.ts` (POST /), mount + wire + export.

### Desktop Rust

- `spool.rs`: `EvidencePaths` (:68-73) + `evidence_paths_at` (:123-133) gain `shift_windows_path`
  (`shift-windows.json`) and `shift_commits_path` (`shift-commits.json`) in the (account, org)
  namespace; update all constructors/tests.
- New `src/git_evidence.rs` (read-only git, never fetch/pull/write): `run_git` via
  `tokio::process::Command` + `#[cfg(windows)] CREATE_NO_WINDOW` (quota.rs:302-307 template) +
  `tokio::time::timeout(10s)`; `discover_repo(cwd)` (rev-parse --show-toplevel / --abbrev-ref
  HEAD); `commits_in_window(root, start_head, started, ended)` - `git log start_head..HEAD
  --pretty=format:%H%x1f%aI%x1f%s` bounded by the sha the hook records on the Started event, by
  this machine's own git committer identity (`--committer=<user.email>`, skipped when the repo
  resolves no identity), and by author date filtered in Rust (authoritative); subjects truncated
  to 500; `default_ref` (origin/HEAD -> origin/main -> origin/master -> None);
  `verify(root, sha, authoredAt)` - reverted: `git log default_ref --since=authoredAt --grep="This
  reverts commit <sha>"`; merged: `merge-base --is-ancestor sha default_ref`, or `git cherry` shows
  the patch already applied upstream, or a commit on the default ref names the sha; orphaned:
  `cat-file -e` fails or `for-each-ref --contains` empty; else pending.
- New `src/shift_commits.rs`: `ShiftWindow` map keyed `source|external_session_id` in
  shift-windows.json (under `spool::with_lock`, browser.rs sidecar precedent; stale opens reaped
  after 7 days); `CommitEntry` registry in shift-commits.json {client_id uuid v4, source,
  external_session_id, repo_root, branch, sha, subject, authored_at, verification, verified_at,
  synced, rejected} (durable - the spool truncates, this doesn't; decided+synced pruned after 90
  days); `capture_from_spool(paths)` - reads pending agent-spool lines via
  `read_pending_lines::<SpoolEvent>` WITHOUT truncating, upserts windows on Started, on Ended runs
  discover_repo + commits_in_window once per shift (idempotent via `captured` flag + registry
  dedup); `unsynced`/`mark_synced`/`mark_rejected`.
- `api.rs`: `ShiftCommitUpload` camelCase struct + `upload_shift_commits` (upload_segments :799
  template). `uploader.rs upload_once` (:61-108): call `capture_from_spool` first (extend
  signature to carry paths; both call sites); after the existing uploads, gate
  `upload_shift_commits_spool` on both agent-spool drains having succeeded; on outcome
  mark_synced(accepted), leave "unknown_session" rejections unsynced, mark_rejected the rest;
  transport error -> nothing marked.

Tests - API: routes/shift-commits.test.ts (idempotency template routes/activity.test.ts:91-134:
replay accepted; unknown_session; same-agent duplicate once; different-agent same sha twice;
pending->merged advances; decided->pending no-op; null-agent session stamped);
services/shift-commits.test.ts; contracts cases. Rust: scratch git repos with controlled
GIT_AUTHOR_DATE (window filtering, non-repo cwd records nothing, replay captures once); uploader
stub_server suite (uploader.rs:418-657 template - commits only after agent drain; unknown_session
survives; exact wire bytes); sidecar lock/corruption per spool.rs:2927-3025 templates.

Risk notes: API must deploy before any installer carrying this ships; sessions whose Started
predates the feature record nothing (accepted); git only runs on Ended processing + daily job,
never per-tick.

## Step 4 - local verification job + surfaces

- `shift_commits::run_verification_pass(paths)`: for each registry entry pending && !rejected &&
  repo_root exists -> `git_evidence::verify`; on decided: set verification + verified_at=now,
  synced=false. Missing repo -> untouched (pending is a state, not a failure).
- `lib.rs`: `spawn_verification_checks` beside `spawn_update_checks` (:759-772 template) in
  `.setup()` (:811-868): run at launch, then 24h sleep loop; re-resolve identity/paths each pass.
  State changes ride the next 5-minute upload pass.
- Web paystub: verification badges + verifiedAt; held-share = merged / decided, null -> "pending".
- `RecordingPanel.tsx`: KEPT (:49-53) add: "For AI coding shifts in a git repo: the branch name,
  and the title, commit id, and repository folder of each commit made during the shift, checked
  later on this machine, read-only. The repository folder is shown only to you and your workspace's
  admins." NEVER (:55-63): amend "The titles of your windows, files, or documents." with "Commit
  titles are the one exception, listed above." Update any test pinning these strings.
- README "How session tracking works": one paragraph on agents-as-identities, shift-end branch +
  commit-title capture, local read-only verification (AGENTS.md requires this section stay true).

Rust tests: scratch repo + local second clone as origin (fetch only in test setup - product code
never fetches): merged / reverted / orphaned / no-remote pending / deleted-dir pending; pass flips
synced only on change. API: replayed decided rows are no-ops. Web: badge rendering.

## Step 5 - pay-run report + parity + desktop All-stats tabs

### API

Contracts: `agentsReportFiltersSchema` {from?, to?, fromAt?, toExclusiveAt?, scope?:
projectScopeSchema} `.strict()` + superRefine; `agentsReportRowSchema` {agent, agentSeconds,
shiftCount, commitsRecorded/Pending/Merged/Reverted/Orphaned, heldRate|null};
`agentsReportResponseSchema` {filters, headcount {total, anonymous, registered, retired}, rows}.
`meStatsResponseSchema` gains `agents: meStatsAgentSchema[]` (same row minus owner).

`AgentIntervalRecord` gains `agentId: string|null`; `readAgentIntervals`
(drizzle-repositories.ts:760-799) selects it. reports.ts: `agentsReport(subject, filters)` -
reapStale; normalizedQuery + scopeQuery; group intervals **by agentId** (group before summing,
:252-254); null-agentId intervals excluded (legacy = absence); join `agents.listForOrganization` so
zero-hour agents still list (collectMembers :128-147 pattern); merge `shiftCommits.countsByAgent`;
`safeInteger` on sums. Report-service deps grow `agents` + `shiftCommits?`. Route: `GET
/reports/agents` in routes/reports.ts. `/me/stats`: same per-agent grouping caller-scoped.

### Web

`client.agentsReport(params)`; the Agents tab fills hours/shifts/commits/held columns from
`/reports/agents`; headcount line ("Headcount 4 - 1 anonymous"). contract-compatibility.test.ts
parses the exact query emitted.

### Desktop - the user's tab request

- `api.rs` `agents_report(token, from_at, to_exclusive_at)` (leaderboard template);
  `lib.rs` `#[tauri::command] agents_report` (org_overview :355-376 template) + registration in
  `generate_handler!` (:870-895); `bridge.ts` invoke + full hand decoder (heldRate null-safe).
- `App.tsx` All-stats overlay: the panel-head h2 org name (:1479-1480) is **replaced by a
  Humans | Agents tab toggle** (org name is already on the main screen's filing header). Humans tab
  = existing board-list + member-stats detail, unchanged. Agents tab = read-only roster list in the
  same board-list grammar (name, source label, hours, shifts, held-share; anonymous greyed), fed by
  the new bridge call with the overlay's range bounds; member-stats section renders only on the
  Humans tab. Scope select is already gone (step 0.5).

Tests: routes/reports.test.ts + services/reports.test.ts (MemoryReports grows agentId intervals +
fake ShiftCommitRepository; parity case: /me/stats agents rows == org report rows filtered to the
caller); routes/me-stats.test.ts; web App.test.tsx; desktop App test for the tab toggle with a fake
bridge.

## Cross-cutting

- Commit per step (0, 0.5, 1, 2, 3, 4, 5), descriptive messages, push with
  `git push -u origin claude/roster-v1-master-plan-jbak2h` (retry 4x exponential backoff on network
  failures).
- Deploy notes (for the user, manual): apply both migrations deliberately (dry-run against a
  replica built from production's journal - DEPLOY.md); deploy API (Railway) before/with web
  (Vercel) - this also fixes the current fake-zeros table since the deployed API predates
  sessionCount/maxConcurrent/medianSeconds. Desktop changes reach users via an installer release;
  bump `apps/desktop/src-tauri/tauri.conf.json` once when that release is cut. Never gate behavior
  on `debug_assertions`.

## Verification

Per step and at the end:
- `pnpm typecheck && pnpm test && pnpm build` (repo root)
- `~/.cargo/bin/cargo fmt --check`, `clippy --all-targets -- -D warnings`, `cargo test` - all with
  `--manifest-path apps/desktop/src-tauri/Cargo.toml`
- After each `drizzle-kit generate`: read the emitted SQL, prune drift leftovers, confirm
  schema.test.ts passes
- Integration suites if a disposable Postgres is available: `TEST_DATABASE_URL=... pnpm test`
  (smoke.integration.test.ts + new gated cases); if no disposable Postgres is available, note that
  in the final report instead of skipping silently
