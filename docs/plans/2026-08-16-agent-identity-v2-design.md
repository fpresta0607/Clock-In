# Agent identity v2 - design

## Scope

Agent identity v2 fixes the two ways the roster lies today: it has no operator dimension, and it is keyed on the SIQshift project rather than the codebase the agent actually works on.
This document is the implementation plan; it changes no application code.

The design stays inside the shipped product model: agents are durable identities (one row per harness at a workplace), a model is an attribute of a shift and never an identity, and browser spans stay off the roster (`rosterEligibleSource`, `apps/api/src/services/agent-sessions.ts:20`, unchanged).

### Production evidence this design is built from (gathered 2026-08-16, do not re-litigate)

- `agents` identity today is `(organization, source, project)` with no operator dimension.
  Production holds exactly 2 rows, both `claude_code`, both `owner_user_id` = Gianluca (minted first 2026-08-15), named `Claude Code @ General` and `Claude Code @ unassigned`.
- Francesco has 199 `agent_sessions` rows; the 16 with `agent_id` set are all stamped onto Gianluca's 2 agent rows.
  Whoever mints first owns the identity; every other member's shifts accrue to it.
  This is why the roster appears "only under Gianluca".
- Session capture already carries `cwd` per session (`agent_sessions.cwd`, `packages/database/src/schema.ts:351`) and `shift_commits.repo_root` per commit (`schema.ts:421`); attribution resolves cwd to project with a **null** fallback, not a General/default one (`apps/api/src/services/attribution.ts:30-49`) - "General" is an ordinary project seeded at organization creation (`drizzle-repositories.ts:692`), so `Claude Code @ General` is a real path-mapping hit rather than a default anyone fell back to.
  That is why the null bucket below can be treated as honest "not known yet" rather than a silent default.
  Token capture (`agent_usage`) and model heartbeats shipped in effort-v1.
- Most terminal agentic sessions on the fleet PC (kimi, pi, cfo-spawned goblins) never record at all because only Claude Code's hooks are wired there.
  Hook coverage will expand (snippets exist in `packages/shared/src/agent-runtimes.json`), but identity must not depend on it.

## Decision summary

- Migrate the `agents` table **in place**; no new table.
- New identity key: `(organization_id, owner_user_id, source, repo_root)` with `repo_root` nullable; null is the per-operator unassigned bucket.
- `project_id` stays on `agents` as a nullable, re-derivable attribute and leaves the identity key.
- The operator is the authenticated uploader, so the operator dimension works for every runtime the moment its hooks are wired, with no per-runtime work.
- Repo identity is discovered early from an optional `repoRoot` on the started event when the desktop can supply it, and late from `shift_commits.repo_root` otherwise; late discovery graduates the unassigned agent instead of stranding the shift.
- The prod reset is re-attribution, not deletion: the 2 existing agent rows are retired and their 45 sessions re-stamped onto v2 identities; `shift_commits` and `agent_usage` evidence moves with its session and no evidence row is ever deleted.

## 1. The identity key

### New key

`(organization_id, owner_user_id, source, repo_root)`, with `repo_root` nullable.

`owner_user_id` already exists on `agents` (`schema.ts:286`) and is already written at mint (`drizzle-repositories.ts:1314-1343` via `services/agent-sessions.ts:105-113`); v2 simply admits it to the identity.
`repo_root` is a new nullable text column with the same 1..1000 shape check `shift_commits.repo_root` carries (`schema.ts:462`), written null-or-valid rather than notNull.

The two existing partial unique indexes (`schema.ts:305-310`) are replaced by:

- `uniqueIndex on (organization_id, owner_user_id, source, repo_root) where repo_root is not null and status <> 'retired'`
- `uniqueIndex on (organization_id, owner_user_id, source) where repo_root is null and status <> 'retired'`

Retiring still releases the key, exactly as migration 0013 established.
The composite-FK target `unique(organization_id, id)` (`schema.ts:297`) is untouched, so every referencing FK keeps working.

### Why repo, and why project leaves the key

- Repos are what agents actually touch; projects are org-wide containers.
  Two repos inside one project must not collapse into one agent, and today they do.
- `repo_root` is raw evidence the system already collects (`shift_commits.repo_root`, and session `cwd` as its proxy); a project is a user decision expressed through `project_path_mappings` (`schema.ts:538-574`).
  User decisions change; identity must not churn when they do.
  When a directory is mapped to a project, or re-mapped, only the `project_id` attribute moves.
- Project stays on the row because the roster still groups and filters by project, and because `resolveProjectForCwd` (`attribution.ts:30-49`) already computes it at ingest.

### Nulls, renames, and the unassigned bucket

- `repo_root = null` is the unassigned bucket, now **per operator**: one row per `(org, operator, source)`.
  It is a real roster row that accumulates hours, shifts, held rate, and tokens, and it graduates (section 2) when repo evidence arrives.
- Renaming the agent (the registration ceremony, `services/agents.ts:150-186`) touches `name` and `status` only; identity columns never change on rename.
- A renamed or moved directory produces a *new* `repo_root`, hence a new agent.
  The repair is the existing admin merge endpoint (`services/agents.ts:188-199`, `routes/agents.ts:52`) - but it is **not** usable unchanged, and v2 is what makes that matter.
  `DrizzleAgentRepository.merge` (`drizzle-repositories.ts:1392-1417`) re-points `agent_sessions` and `shift_commits` (with the `(agent, repo_root, sha)` collision guard at `:1404-1410`) and never touches `agent_usage.agent_id`, so today a merge strands the loser's token rows on a retired row.
  That is a shipped gap nobody hits often because merges are rare; under v2 a moved repo makes merge the ordinary repair, so fix it in the same transaction.
  Re-pointing cannot collide: the bucket unique (`schema.ts:507-509`) is keyed on `agent_session_id`, which does not move.
  Anchoring identity on `project_path_mappings.repo_url` (`schema.ts:546`) so one repo survives moves and machine differences is a possible later hardening and is deliberately out of scope.
- The same operator running the same repo on two machines mints one agent per machine path.
  That is accepted: shift evidence is machine-local today (shift commits verify on the machine that ran the shift), and the display name (section 3) keeps the two rows readable.

### Migrate in place, not a new table

Every endpoint, contract, decoder, and UI surface is keyed on `agents.id`: the roster list (`services/agents.ts:146-148`), the patch handler, the paystub builder (`services/agents.ts:201-307`), `/reports/agents` (`services/reports.ts:722-762`), and the three evidence FKs (`agent_sessions` `schema.ts:383-387`, `shift_commits` `schema.ts:447-451`, `agent_usage` `schema.ts:515-519`).
A new table would fork all of them and force a dual-read transition for zero structural benefit; the change is one new column, one key widened by an existing column, and two index swaps.

## 2. Minting and re-attribution rules

### Operator at mint, for every runtime

The operator is `subject.userId` from the authenticated uploader (`apps/api/src/auth.ts:15-17`), which `resolveAgent` already passes as `ownerUserId` (`agent-sessions.ts:105-113`).
Because identity is minted server-side from whatever events arrive, the operator dimension needs nothing from the runtime itself: the day kimi, pi, or a cfo-spawned goblin's hooks are wired on the fleet PC, its shifts mint under the account that machine's desktop is signed into, and never merge into another member's agent.
One assumption is stated plainly: the operator of a shift is the member whose desktop uploaded it.

### Repo at mint

`agentSessionEventSchema` (`packages/shared/src/contracts.ts:463-494`) gains one optional field, `repoRoot` (string 1..1000).
The desktop already shells out to git at session start to capture `start_head` (`spool.rs` `SpoolEvent.start_head`, :672-694), so `siqshift-hook` learns the repo root from the same probe (`bin/siqshift-hook.rs:45-49`) and the spool carries it beside `cwd`.

**The obvious reuse does not compile, so do not plan on it.** `git_evidence::discover_repo` (`git_evidence.rs:61-67`) runs exactly the wanted `git rev-parse --show-toplevel`, but it is `async` over `tokio::process::Command` (`:13`, `:29-49`) and the hook is a synchronous binary with no runtime.
`head_sha` states the reason in its own doc comment (`git_evidence.rs:73-75`): synchronous on purpose, because the hook must never block the agent CLI that invoked it.
So the probe is a sibling `pub fn repo_root(cwd: &Path) -> Option<PathBuf>` beside it (`git_evidence.rs:76-93`) with the same `std::process::Command` shape, the same `Stdio::null()`, the same `#[cfg(windows)] CREATE_NO_WINDOW` (`:19`) so no console flashes, and the same collapse-any-failure-to-`None` rule; `discover_repo` keeps its async form for the uploader's shift capture.
One more asymmetry to respect: `upload_agent_spool` blanks `start_head` before upload (`uploader.rs:202-208`) because it is sidecar-local. `repo_root` must **not** join that loop - it is contract data.
The wire-struct trap from effort-v1 applies unchanged: `AgentEventUpload` (`apps/desktop/src-tauri/src/api.rs:417-444`) must project the new field explicitly, the exact-wire-bytes test (`uploader.rs:1153-1174`) is re-pinned, and the installer ships only after the API that accepts the field is deployed (section 6).

`resolveAgent` (`agent-sessions.ts:99-118`) keys the per-batch upsert cache on `(source, operator, repoRoot ?? "")` instead of `(source, project)`.
`upsertForKey` (`drizzle-repositories.ts:1314-1343`) takes the new key, targets the two new partial indexes, and keeps its replay rule: conflict touches `updated_at` only, never name, owner, or status.
Its `targetWhere` (`:1336-1338`) has to move with them, to `repo_root is not null and status <> 'retired'` and `repo_root is null and status <> 'retired'` respectively.
Postgres matches ON CONFLICT to a partial index by that predicate, so a `targetWhere` left at today's bare `status <> 'retired'` fails no test against a mocked repository and then fails every insert in production with "no unique or exclusion constraint matching the ON CONFLICT specification".
Project attribution at ingest is unchanged in mechanism - `resolveProject` (`agent-sessions.ts:121-124`) - but matches `repoRoot` first when present and falls back to `cwd`; the result is written to both the session row and the agent's `project_id` attribute.

### Late discovery: graduation, not orphaning

A shift that starts with a `cwd` but no repo evidence mints into the operator's unassigned bucket and is stamped first-assignment-wins (`upsertStarted` coalesce, `drizzle-repositories.ts:1174-1176`).
When a `shift_commits` batch later reveals `repo_root` for that session, `services/shift-commits.ts:82-98` (which already late-mints and stamps via `stampAgent`, `drizzle-repositories.ts:1277-1287`) gains the graduation step:

1. If the session's agent has `repo_root` null, set it - first-assignment-wins, mirroring the `agentId` and `model` coalesces (`drizzle-repositories.ts:1174-1176`, `:1227-1261`).
   The agent row keeps its id, so its hours, shifts, tokens, and commits move with it; nothing is re-summed.
2. If the upsert collides with an existing `(org, operator, source, repo_root)` agent - another shift got there first - the colliding session is re-stamped onto the existing agent, and its `agent_usage` and `shift_commits` rows follow their session (both tables key evidence by `agent_session_id`, `schema.ts:490` and `:419`, so this is one indexed update per table).
   An unassigned agent left with zero sessions is retired automatically; its history is empty by construction, so retiring loses nothing.
3. If the evidence names a `repo_root` that differs from the session's agent's current `repo_root` - the agent already graduated to a different repo, or was repo-keyed all along - that session is re-stamped onto find-or-create `(org, operator, source, evidence repo_root)` through the same `upsertForKey` path, and its `agent_usage` and `shift_commits` rows follow it exactly as in rule 2.
   This is what keeps the old-installer degradation path (section 6, step 6: every session starts repo-less in the shared per-operator unassigned bucket) correct for an operator working several repos before any commits arrive: the bucket graduates to the first repo reported, and each later report re-homes only its own session.
4. `agent_usage` has the same late-mint site (`services/agent-usage.ts:62-69`) and follows the same rule.

A directory mapped to a project *after* agents minted moves nothing in identity: the agent's `project_id` is re-derived from its `repo_root` against the current mappings (the same longest-prefix match, `attribution.ts:30-49`) whenever the paystub or report reads it, or lazily on the next event for that agent.
Session rows keep their own ingest-time `project_id` exactly as today; per-session attribution and per-agent identity are separate questions.

## 3. Roster and UX changes

- **Default display name.** The composed default (`drizzle-repositories.ts:1330`) becomes `<runtime label> @ <repo folder name>`, with the unassigned bucket keeping `@ unassigned`.
  The folder name is the basename of `repo_root`, computed at mint; the full path is never required for display.
- **Web roster** (`apps/web/src/App.tsx:1479-1660`): rows group by operator (`agent.owner.name`, already on every row via `agentSchema`, `contracts.ts:522-532`), then by repo within an operator.
  The secondary line (`:1570-1573`) becomes `runtime label · repo name · model mix`; the owner stops being a secondary-line fact and becomes the grouping header.
  Rename (`:1533-1550`) and the retired tag (`:1561-1562`) are unchanged.
- **Desktop roster** (`apps/desktop/src/App.tsx:2099-2154`) stays read-only and gains the owner and repo name on its secondary line (`:2125-2130`).
- **Paystub** (`apps/web/src/App.tsx:1592-1656`): the header names the repo beside the agent name; metrics, shift list, and TrendStrip are unchanged.
- **Path disclosure.** `repo_root` is a working directory, so it follows the existing `repoRoot` rule exactly: the basename is safe for every member, the full path renders only for the agent's owner and workspace admins, mirroring the paystub gate at `services/agents.ts:220` and the projection comment at `:97-103`.
  The three disclosure sentences (`apps/web/src/HelpModal.tsx:13-24`, `apps/desktop/src/RecordingPanel.tsx:49-65`, README "What is never collected") already cover "which folder it worked in" (`RecordingPanel.tsx:52`); they are re-read against what v2 actually sends and reworded only if the set changes.
- **Agents-tab session tables** (`apps/web/src/App.tsx:176-213`, `apps/desktop/src/App.tsx:181-220`) are shift-fact tables keyed `(source, model)`; they do not change.
- **Retired and renamed agents** survive exactly as today: retired rows keep their history and leave the active headcount (`contracts.ts:695-702`), and rename remains the registration ceremony.

## 4. Reset and backfill procedure (prod-safe, step by step)

Goal: the 2 production agent rows stop receiving shifts, and the 45 stamped sessions (plus their `shift_commits` and `agent_usage` rows) land on v2 identities.
Re-attribution is preferred over deletion throughout; nothing in this procedure deletes an evidence row.

What references an agent row (all `onDelete: restrict`, which is why naive deletion is not even possible):

- `agent_sessions.agent_id` (`schema.ts:383-387`)
- `shift_commits.agent_id` (`schema.ts:447-451`)
- `agent_usage.agent_id` (`schema.ts:515-519`)

Sequence:

1. **Snapshot.** Take a database backup before any step; the whole procedure is reversible from it.
2. **Retire the 2 old rows** through the existing endpoint (`PATCH /agents/:id`, `routes/agents.ts:40`, `services/agents.ts:150-186`).
   This works on the currently deployed API, immediately stops new stamps onto them visually, and - because both the old and the new partial uniques exclude `retired` - clears the key-space collision the schema migration would otherwise hit (both old rows are `(org, gianluca, claude_code)` with `repo_root` about to be null, which the new unassigned index would reject as a duplicate).
3. **Apply the schema migration** (section 6).
4. **Deploy the new API.** New shifts now mint v2 identities on their own.
   Steps 2 through 4 run back-to-back in a single ops window: the old API keeps minting v1-keyed agents through `upsertForKey` until it is replaced, and a row re-minted in that gap re-creates the duplicate the new unassigned partial unique rejects, failing the step-3 migration.
5. **Run the backfill** as a one-off, deliberately invoked routine (an API-side script under `scripts/`, not a drizzle migration - migrations here are generated from `schema.ts`, never hand-written):
   - For every roster-eligible `agent_sessions` row whose `agent_id` names any agent still keyed on the v1 identity `(org, source, project)`, regardless of status - the 2 retired rows plus any row minted before the v2 API deployed, including one re-minted in the step 2-to-4 window: operator = `agent_sessions.user_id`; repo = the session's own `shift_commits.repo_root` when one exists, else null.
     The dry run prints both counts - sessions on the 2 retired rows and sessions on any other v1-keyed row - before anything writes.
   - Find-or-create the v2 agent through the same `upsertForKey` path (default name composes as in production).
   - Re-stamp the session, then update `agent_usage.agent_id` and `shift_commits.agent_id` for that `agent_session_id`.
     `stampAgent`'s `isNull` guard (`drizzle-repositories.ts:1277-1287`) does not apply here; the backfill uses an explicit re-stamp that overwrites, which is also the graduation machinery from section 2 reused with a force flag.
   - Francesco's 183 unstamped legacy rows are offered the same pass as an explicit, separately confirmed step: roster-eligible ones (source <> 'browser') mint and stamp under their owner's v2 identity.
     Its dry run prints the eligible and skipped counts before anything writes.
6. **Verify.** Zero `agent_sessions`, `shift_commits`, and `agent_usage` rows reference the retired agents; the roster shows one row per (operator, runtime, repo); the paystub hours for a re-stamped agent equal the sum of its sessions before and after.
7. **Leave the 2 old rows retired** as audit trail.
   Deletion is possible once step 6 shows zero references (all three FKs are `restrict`, so the database itself enforces that precondition), but retirement is the default end state.

During the window between step 4 and step 5 the roster shows the retired v1 rows beside fresh v2 rows; that is expected and communicated, not an error state.

## 5. Effort and quality surfacing - every contract change

Hours, shift count, held rate, and tokens per agent already exist end to end: `agentsReportRowSchema` (`contracts.ts:671-690`) carries `agentSeconds`, `shiftCount`, the four commit counts, `heldRate`, `models`, `tokens`, `tokensReported`; the paystub (`contracts.ts:592-647`) adds the per-model token split and the six-bucket trend; `/reports/agents` already ranks by hours or tokens (`services/reports.ts:747-751`).
V2 changes *who those numbers belong to*, not how they are computed; held rate stays client-attested and labeled as such (`apps/web/src/App.tsx:1616-1624`, README:261-264).

Because the report filters and event schemas are `.strict()`, every shape change is called out:

1. **`agentSessionEventSchema`** (`contracts.ts:463-494`): additive optional `repoRoot` (string 1..1000).
   Old desktops simply never send it; a new desktop against an old API would 400, which is why section 6 orders API before installer.
   Its `superRefine` (`:474-494`) gains the matching clause, because the field is not purely additive: that refinement is what enforces "a `browser` span carries a `ruleId` and no `cwd`, an agent event the reverse", and a browser span has no working directory to have a repo root in.
   Without the clause the schema accepts a browser payload carrying `repoRoot` and hands it to a code path that never resolves one.
2. **`agentSchema`** (`contracts.ts:522-532`): gains `repoName` (basename, safe for all members) and optional `repoRoot` (full path, projected only for owner/admin, mirroring `shiftCommitViewSchema.repoRoot`, `contracts.ts:566-581`).
   **Both must be `.optional()`, not `string | null`,** and that is not a style preference.
   `patch` re-validates the whole merged record against `agentSchema` (`services/agents.ts:164-172`), building its object literal field by field; a required-but-nullable `repoName` absent from that literal makes every `PATCH /agents/:id` throw "The resulting agent is invalid" - a rename failing on a field the request never mentions.
   Add both fields to that literal as well, so the check keeps checking the real record.
   Optional is also what lets the projection omit `repoRoot` for a non-owner instead of blanking it, which is the rule `shiftCommitViewSchema.repoRoot` already follows.
3. **Inherited, no edits:** `agentsReportRowSchema` and `meStatsAgentSchema` (`contracts.ts:907-910`) embed `agentSchema`; `agentsReportResponseSchema.headcount` (`:692-705`) is unchanged; `agentPaystubResponseSchema` is unchanged beyond the embedded agent; `agentPatchRequestSchema` (`:537-544`) is unchanged (no one patches identity columns).
4. **Decoders follow the additive rule:** `decodeAgentsReportRow` (`apps/desktop/src/bridge.ts:851-880`) decodes absent `repoName`/`repoRoot` to null, never a crash; the Rust report structs keep `#[serde(default)]` on the new fields (the `api.rs:224-235` pattern).
   `tokenTotalsSchema`, `hourlyBucketSchema`, and the upload/batch contracts are untouched.
   On the desktop this means one absence decoding for two different reasons - an API older than the field, and an API that deliberately withheld the path from this caller - and both must read the same.
5. **The routes re-parse what the service projects,** which is where a projection mismatch actually surfaces: `GET /agents` runs `agentsListResponseSchema.parse` (`routes/agents.ts:37`) and `PATCH /agents/:id` runs `agentSchema.parse(asAgentView(updated))` (`routes/agents.ts:49`).
   Both schemas are `.strict()`, so an `asAgentView` that emits `repoRoot` for a caller the schema does not expect - or omits one it requires - is a 500 on a read path, not a type error at build time. Optional fields on both sides are what keep the owner and non-owner projections parsing through the same schema.

## 6. Migration sequence and deploy order

1. **Schema.** Edit `packages/database/src/schema.ts` (new column, two index swaps), then `pnpm exec drizzle-kit generate --name agent_identity_v2` from `packages/database`, then **read the emitted SQL before trusting it**.
   The repo's journal is currently consistent (15 SQL files, 15 snapshots, 15 journal entries through `0014_agent_usage`), but the meta snapshots have drifted before and production's `drizzle.__drizzle_migrations` holds entries this repo no longer carries, so the migration is dry-run against a replica built from production's own journal exactly as `DEPLOY.md:82-114` prescribes.
   The generated SQL must contain only: the `repo_root` column add, the two index drops, the two index creates.
2. **Pre-migration data step.** Retire the 2 v1 agent rows (section 4, step 2) so the new unassigned partial unique cannot collide on them.
3. **Apply the migration deliberately.** Nothing migrates on deploy; this is a separate, confirmed step.
4. **Deploy the API (Railway) before or with the web dashboard (Vercel)** - the report filters are `.strict()`, so a newer web bundle against an older API gets bare 400s (DEPLOY.md).
   The API is backward compatible with old desktops throughout: every new field is optional on ingest and additive on responses.
   Between step 3 and this step there is an unavoidable window where the running API's ON CONFLICT arbiters name indexes the migration has just dropped, so every `POST /agent-sessions` batch fails.
   Ordering cannot remove it - deploying the new API first only moves the failure to arbiters whose indexes do not exist yet - so keep the window to minutes and know what it costs, which is nothing durable: `upload_agent_spool` (`apps/desktop/src-tauri/src/uploader.rs:193-222`) returns before `truncate_acked` on any upload error, so the spool keeps the events and replays them whole next pass. No shift is lost; some arrive late.
5. **Old rows during the transition.** Retired v1 rows keep all history and stay readable; sessions stamped to them keep rendering in reports until the backfill re-stamps them; new shifts never touch them.
6. **Desktop ships last, via installer only.** The hook's `repo_root` probe and the `AgentEventUpload` projection ship in the next installer release; `tauri.conf.json` is bumped once when that release is cut, and never before the API accepting `repoRoot` is live.
   Old installers keep working against the new API indefinitely - their shifts mint per-operator unassigned agents and graduate late through `shift_commits`, which is the designed degradation path, not an error.

## What this deliberately does not do

- No repo-URL identity anchoring, no cross-machine agent unification, no parentage between orchestrator and sub-agent identities.
- No change to how time is measured (active time stays a union, agent time stays a sum), to model-as-shift-attribute, or to `rosterEligibleSource`: browser spans never mint agents.
- No deletion of evidence rows anywhere in the reset; retirement over deletion.
- No per-runtime work for the operator dimension; hook coverage expands on its own schedule and identity does not wait for it.

## Verification

Per implementation step: `pnpm typecheck && pnpm test && pnpm build` from the root; `~/.cargo/bin/cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test`, each with `--manifest-path apps/desktop/src-tauri/Cargo.toml`.
After `drizzle-kit generate`, read the emitted SQL and prune drift leftovers.
Run the integration suites against a disposable Postgres (`TEST_DATABASE_URL=... pnpm test`) when one is available, and say so in the final report when none is.

New tests pin, specifically:

- the v2 upsert arbiter against **a real Postgres**, both halves - the `targetWhere`/index-predicate mismatch in section 2 is invisible to a mocked repository and fails only where a real planner has to pick the index;
- `PATCH /agents/:id` renaming an agent that carries a repo, which exercises the whole-record re-validation at `services/agents.ts:164-172` and the route's own `agentSchema.parse` (`routes/agents.ts:49`) - the one place the contract shape can break a request that never mentions the new fields;
- the disclosure projection: a member who owns neither agent reads `GET /agents` and `/reports/agents` and gets `repoRoot` **absent** while `repoName` is present, and the desktop decoder reads that absence as null rather than failing;
- `agentSessionEventSchema` rejecting a `browser` event that carries a `repoRoot`;
- `merge` re-pointing `agent_usage.agent_id`, which no test covers today because the behavior does not exist;
- the graduation rules 1 through 3 including the collision path, and the hook's synchronous repo probe (a repo cwd, a non-repo cwd, and git absent from PATH - each an honest `None`, never an error) plus the upload struct's exact wire bytes with and without the field.

By hand against a staging copy of production data: retire the v1 rows, migrate, backfill, and confirm the roster shows one agent per (operator, runtime, repo), the 45 re-stamped sessions carry their commits and usage with them, a fresh shift from a second member mints its own identity, and a shift with no repo evidence lands in that member's unassigned bucket and graduates when its first commit verifies.
Then sign in as a member who owns neither agent and confirm no full path is in any response - the roster still reads correctly, because `repoName` carries the folder name.
