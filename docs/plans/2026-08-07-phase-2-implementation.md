# Clock-In Phase 2 Implementation Plan

**Goal:** Turn the manual stopwatch into a corroborated tracker: OS activity segments, agent CLI session hooks, server-side project attribution, and corroboration-aware reporting, with full user visibility in the desktop UI.

**Architecture:** Per `docs/plans/2026-08-07-phase-2-design.md`. Evidence lives in three new tables beside `time_sessions`; the desktop gains a read-only activity monitor and a `clock-in-hook` spool binary; the API gains ingestion routes, prefix-match attribution, and corroboration math in the reporting service. No changes to `time_sessions` columns. The desktop UI is already restyled on the shared SIQstack brand (`packages/shared/styles/brand.css`).

**Tech Stack:** unchanged from Phase 1 (TypeScript 5, pnpm, Vitest, Zod, Drizzle/PostgreSQL, Hono, React 19, Vite, Tauri 2, Rust).

**Working agreements:** test-first per package conventions; no git commits unless the user asks; desktop Rust changes must keep `cargo test`/`cargo fmt --check` green when the toolchain is available.

---

### Task 1: Shared contracts for evidence and stats

**Files:**
- Modify: `packages/shared/src/contracts.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/contracts.test.ts`

**Steps:**
1. Add tests for: activity-segment kinds and batch upload (bounded array, per-row timestamps), agent sources and event kinds, agent-event batch, path-mapping create/update/list, `me/stats` response, and `corroboratedSeconds` on report rows and leaderboard entries.
2. Confirm failures, then implement:
   - `activitySegmentKindValues = ["active","idle","locked","suspended"]`; `activitySegmentUploadSchema` `{ clientId: uuid, deviceId: uuid, kind, processName?: string max 200, startedAt, endedAt }` strict; `activitySegmentBatchRequestSchema` `{ segments: array(1..500) }`; response `{ accepted: int, rejected: array({ clientId, reason }) }`.
   - `agentSourceValues = ["claude_code","codex","kimi_code","other"]`; `agentEventKindValues = ["started","ended","heartbeat"]`; `agentSessionEventSchema` `{ source, externalSessionId: string min 1 max 200, event, occurredAt, cwd: string min 1 max 1000 }`; batch request `{ events: array(1..500) }`; response per-event accept/reject.
   - `projectPathMappingSchema` `{ id, pathPrefix: string min 1 max 500, repoUrl: string nullable optional, projectId: uuid }`; create/update requests; list response.
   - `meStatsResponseSchema` `{ filters: { from?, to? }, totalDurationSeconds, corroboratedSeconds, projects: array({ project: { id, name }, durationSeconds, corroboratedSeconds, sessionCount }) }`.
   - Add `corroboratedSeconds: int nonnegative safe` to `reportRowSchema` and `leaderboardEntrySchema`.
3. Run shared tests and typecheck.

### Task 2: Database tables and migration

**Files:**
- Modify: `packages/database/src/schema.ts`
- Create: `packages/database/migrations/0001_phase2_evidence.sql` (name per existing migration numbering)
- Modify: `packages/database/src/seed.ts` (optional sample mappings)
- Test: `packages/database/src/schema.test.ts`
- Test: `packages/database/src/migrations.integration.test.ts`

**Steps:**
1. Add schema tests for the three tables, their uniques, checks, and indexes.
2. Implement Drizzle tables:
   - `activitySegments`: `id` uuid pk defaultRandom; `organizationId`, `userId` (composite FK to `users(organizationId, id)`, cascade); `clientId` uuid; `deviceId` uuid; `kind` pgEnum `activity_segment_kind` (`active|idle|locked|suspended`); `processName` text null; `startedAt`, `endedAt` timestamptz; `receivedAt` timestamptz defaultNow; audit columns. Constraints: `unique(organizationId, userId, clientId)`; check `endedAt > startedAt`; check `processName` length ≤ 200; index `(organizationId, userId, startedAt)`.
   - `agentSessions`: `id` uuid pk; org/user composite FK; `source` pgEnum `agent_source` (`claude_code|codex|kimi_code|other`); `externalSessionId` text; `projectId` uuid null (composite FK to `projects(organizationId, id)`, restrict); `cwd` text; `status` pgEnum `agent_session_status` (`running|ended`); `startedAt`; `endedAt` null; `lastEventAt` timestamptz; `linkedSessionId` uuid null FK `timeSessions.id` set null; `receivedAt` defaultNow; audit. Constraints: `unique(organizationId, userId, source, externalSessionId)`; check status/endedAt consistency (`running` ⇒ `endedAt is null`); check `externalSessionId`/`cwd` lengths; index `(organizationId, userId, startedAt)`.
   - `projectPathMappings`: `id` uuid pk; org/user composite FK (cascade); `pathPrefix` text; `repoUrl` text null; `projectId` (composite FK to `projects(organizationId, id)`, cascade); audit. Constraints: `unique(organizationId, userId, pathPrefix)`; check prefix length ≤ 500.
3. Generate/write the migration; run package tests (integration skips cleanly without `TEST_DATABASE_URL`); with a disposable Neon branch run the integration suite.

### Task 3: API ingestion — segments, agent events, path mappings, attribution

**Files:**
- Modify: `apps/api/src/repositories.ts`
- Modify: `apps/api/src/drizzle-repositories.ts`
- Create: `apps/api/src/services/activity.ts`
- Create: `apps/api/src/services/agent-sessions.ts`
- Create: `apps/api/src/services/attribution.ts`
- Create: `apps/api/src/routes/activity.ts`
- Create: `apps/api/src/routes/agent-sessions.ts`
- Create: `apps/api/src/routes/path-mappings.ts`
- Modify: `apps/api/src/app.ts` (wire routes)
- Tests beside each service/route per package convention

**Steps:**
1. Service tests first: idempotent segment batch (same `clientId` replays without duplicating), per-row validation rejecting `endedAt <= startedAt` / future-beyond-tolerance / span > 24h without failing the batch, `receivedAt` stamped server-side.
2. Agent-session upsert tests: start creates running row keyed `(org, user, source, externalSessionId)`; end closes at `occurredAt`; end-before-start tolerated (row created ended); heartbeat advances `lastEventAt`; staleness reaping closes rows with `lastEventAt` older than 6h at `lastEventAt` (run on ingest and on read paths); attribution resolves `cwd` by normalized longest-prefix match (case-insensitive, trailing separators stripped), ties rejected as ambiguous, misses leave `projectId` null; linking attaches a running agent session to the user's running timer when projects match.
3. Path-mapping CRUD tests: per-user scoping, duplicate prefix conflict, project membership required.
4. Implement thin Hono routes under `/v1/activity/segments`, `/v1/agent-sessions`, `/v1/path-mappings` validating with shared schemas; extend rate limits and body bounds per Phase 1 patterns.
5. Run all API tests and typecheck.

### Task 4: Corroboration math and `/v1/me/stats`

**Files:**
- Modify: `apps/api/src/services/reports.ts`
- Modify: `apps/api/src/routes/reports.ts`
- Create: `apps/api/src/routes/me-stats.ts` (or extend existing `me` route location)
- Modify: `apps/api/src/repositories.ts`, `apps/api/src/drizzle-repositories.ts`
- Modify: `apps/api/src/app.ts`
- Tests beside each module

**Steps:**
1. Report-service tests: corroborated seconds = overlap of `[startedAt, stoppedAt]` with the union of the user's `active` segments and linked agent sessions, capped at `durationSeconds`; evidence with `receivedAt > occurredAt + 7 days` excluded; totals split corroborated/uncorroborated; leaderboard entries and report rows carry `corroboratedSeconds`; scoping unchanged (a user only ever sees their own rows in `me/stats`).
2. Implement the overlap query in the Drizzle report repository (SQL interval overlap; keep it set-based, no row-at-a-time loops).
3. Add `GET /v1/me/stats?from&to` returning the shared `meStatsResponseSchema` shape, computed by the same reporting code path.
4. Run API tests and typecheck.

### Task 5: `clock-in-hook` binary and spool

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml` (second `[[bin]]` target)
- Create: `apps/desktop/src-tauri/src/bin/clock-in-hook.rs`
- Create: `apps/desktop/src-tauri/src/spool.rs` (shared append/drain logic, unit-tested)
- Test: inline Rust test modules

**Steps:**
1. Rust tests: stdin JSON parsed per the design contract (`version`, `source`, `event`, `sessionId`, `cwd`, `occurredAt`); locked append produces whole lines under concurrent writers; malformed input exits non-zero without writing; rotation caps the spool at 10 MB; drain acknowledges before truncation and replays on mid-upload crash.
2. Implement `spool.rs` (append with interprocess lock, rotate, drain) and the thin binary over it. No network, no credentials, no sockets.
3. `cargo fmt --check`, `cargo test`, `cargo check` when the toolchain is available.

### Task 6: Activity monitor and uploader (Rust host)

**Files:**
- Create: `apps/desktop/src-tauri/src/monitor.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (spawn tasks, new commands)
- Modify: `apps/desktop/src-tauri/src/api.rs` (segment/agent-event upload, me/stats client)
- Modify: `apps/desktop/src-tauri/src/recovery.rs` if stop needs the measured idle span
- Test: inline Rust test modules

**Steps:**
1. Rust tests: `ActivitySource` trait with a fake source; segment builder folds a signal stream into transition-based segments; 30s tick; idle measurement summed into `idleSeconds` at stop; away-threshold and agent-active-override decisions with injected clock; uploader batches every 5 min and at stop.
2. Implement the Windows source (`GetLastInputInfo`, `GetForegroundWindow` process name only; WTS lock/suspend events from the Tauri window) behind the trait; keep it off until the org/user enables monitoring (settings persisted via the store plugin).
3. Drain the agent spool on the same uploader cadence; expose monitor status (running/paused, last upload, spool backlog, hook registration detected) as a Tauri command for the UI.
4. `cargo fmt --check`, `cargo test`, `cargo check`.

### Task 7: Desktop UI — prompts, status, stats, settings

**Files:**
- Modify: `apps/desktop/src/timer-machine.ts` (suggested-start, away-prompt states)
- Modify: `apps/desktop/src/bridge.ts` (new commands)
- Modify: `apps/desktop/src/App.tsx` (status line, live session card, stats view, settings, privacy panel, hook wizard)
- Tests: `apps/desktop/src/timer-machine.test.ts`, `apps/desktop/src/App.test.tsx`, `apps/desktop/src/bridge.test.ts`

**Steps:**
1. State-machine tests: suggested start from an attributed agent session (confirm/dismiss), away prompt on return (discard subtracts idle / keep), auto-stop at last-active with agent-active override, monitor paused makes time uncorroborated but never blocks the timer.
2. Bridge decoders for monitor status, live stats, me/stats response, path mappings.
3. UI on the shared brand: tray/tooltip states; monitor-health line; live session card (elapsed, idle trimmed, corroborated so far, linked agents with source badges); personal stats view (today/week per project, corroborated mint vs uncorroborated gray) backed by `/v1/me/stats`; settings (thresholds, lock/sleep policy, path mappings, monitoring pause); "what's recorded" panel; opt-in hook-registration wizard with per-CLI status.
4. Run desktop tests, typecheck, and production build.

### Task 8: End-to-end verification

**Files:**
- Modify: `apps/api/src/smoke.integration.test.ts` (extend) or create a Phase 2 smoke test
- Modify: `docs/plans/2026-08-07-phase-2-design.md` if any decision changed during implementation

**Steps:**
1. Smoke: migrate disposable database → seed → sign in → upload segments and a synthetic `clock-in-hook` event → start/stop a timer with measured idle → verify attribution, linking, corroborated seconds, and `me/stats` agree with the org report.
2. Full gate: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`; Rust fmt/test/check; `tauri build` when the toolchain is available.
3. Review the diff for scope, privacy posture (no titles/URLs/content), secret exposure, and dead code.

## Manual verification checklist (post-build, on a real machine)

Automated gates cannot click a GUI. Run this pass with the installed release
build (or `pnpm tauri dev`) against a disposable workspace:

1. **Launch + status**: app boots to sign-in; after signing in, the status line shows monitoring state, last upload, and hook badges. Tray icon state matches.
2. **Monitoring toggle**: Settings → Activity monitoring on; status line flips to "Monitoring on" within a poll cycle; pause → timer still works, time marked uncorroborated.
3. **Idle trim**: start a timer, leave the machine untouched past the away threshold, return → away prompt appears; Discard trims the span (check `idleSeconds` in the stopped session), Keep leaves it billable.
4. **Hard auto-stop**: with a short hard away limit configured, leave the machine past it → timer auto-stops at last-active; pending-sync or confirmation surfaces at next launch.
5. **Agent flow end to end**: Settings → Agent hooks → Register (Claude Code); start a Claude Code session in a mapped directory → suggested-start prompt appears; confirm → timer runs with the project preselected; "agent active — idle trim paused" shows while the agent works; ending the session clears it.
6. **Overnight agent**: lock the machine with an agent session active → timer keeps running (agent-active override), no away auto-stop.
7. **Restart resilience**: with a timer running, kill the app from Task Manager → relaunch → timer restored from reconciliation. Repeat with a graceful tray Quit → relaunch → open activity segment was flushed (corroboration has no trailing gap).
8. **OS shutdown**: timer running, sign out of Windows / reboot → relaunch → same recovery as 7.
9. **Stats honesty**: Stats view totals and corroborated/uncorroborated split match what the org report shows for the same range.
10. **Privacy panel**: "What's recorded" copy matches reality (process names only; spool under `%APPDATA%\clock-in`).
