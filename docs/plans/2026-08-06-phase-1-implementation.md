# SIQshift Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the complete manual time-tracking path across shared contracts, PostgreSQL, the Hono API, and the Tauri desktop shell.

**Architecture:** A plain pnpm workspace owns shared Zod contracts, a Drizzle PostgreSQL package, a thin Hono API, and a React/Tauri desktop. Services enforce authorization and timer invariants behind repository interfaces; the desktop keeps secrets in the OS credential store and only recovery state in its local store.

**Tech Stack:** TypeScript 5, pnpm, Vitest, Zod, Drizzle ORM/PostgreSQL, Hono, React 19, Vite, Tauri 2, Rust, Testing Library

---

### Task 1: Workspace and shared contracts

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/contracts.ts`
- Create: `packages/shared/src/time.ts`
- Create: `packages/shared/src/index.ts`
- Test: `packages/shared/src/contracts.test.ts`
- Test: `packages/shared/src/time.test.ts`

**Steps:**
1. Add tests for login, project, session, report-filter, and stable API-error schemas; add time-format tests for zero, minute, and hour boundaries.
2. Run `pnpm --filter @siqshift/shared test` and confirm it fails because the package or exports do not exist.
3. Add the minimal workspace configuration, named schema/type exports, and pure duration formatter needed by the tests.
4. Run `pnpm install` and `pnpm --filter @siqshift/shared test`; confirm all shared tests pass.
5. Run `pnpm --filter @siqshift/shared typecheck` and commit as `feat(shared): add api contracts`.

### Task 2: PostgreSQL schema, migrations, and seed

**Files:**
- Create: `packages/database/package.json`
- Create: `packages/database/tsconfig.json`
- Create: `packages/database/drizzle.config.ts`
- Create: `packages/database/src/schema.ts`
- Create: `packages/database/src/client.ts`
- Create: `packages/database/src/migrate.ts`
- Create: `packages/database/src/seed.ts`
- Create: `packages/database/src/index.ts`
- Create: `packages/database/migrations/0000_initial.sql`
- Test: `packages/database/src/schema.test.ts`
- Test: `packages/database/src/migrations.integration.test.ts`

**Steps:**
1. Add schema tests for organizations, users, projects, memberships, sessions, indexes, timestamps, and session status values.
2. Run the schema test and confirm it fails because no database package exists.
3. Implement Drizzle tables with UUID primary keys, foreign keys, organization scoping, numeric idle/duration seconds, and a partial unique index allowing one `running` session per user.
4. Add migration, migration runner, and an idempotent development seed using parameterized Drizzle operations.
5. Run `pnpm --filter @siqshift/database test`; confirm static schema tests pass and the integration suite skips with a clear reason when `TEST_DATABASE_URL` is absent.
6. With Neon active, set `TEST_DATABASE_URL` from a disposable branch, run `pnpm --filter @siqshift/database test:integration`, and confirm migrations plus the partial unique index pass.
7. Commit as `feat(database): add initial postgres schema`.

### Task 3: API composition, security, and authentication

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/src/env.ts`
- Create: `apps/api/src/errors.ts`
- Create: `apps/api/src/auth.ts`
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/index.ts`
- Test: `apps/api/src/app.test.ts`
- Test: `apps/api/src/auth.test.ts`

**Steps:**
1. Add HTTP tests for health, bounded JSON bodies, allowlisted CORS, security headers, invalid input, invalid credentials, and signed access tokens.
2. Run the focused tests and confirm they fail because the app/auth modules are missing.
3. Implement strict environment parsing, stable JSON errors, Argon2id password verification, JWT signing/verification, request IDs, body limits, security headers, CORS, and login rate limiting.
4. Keep handlers thin and inject authentication/user lookup dependencies for deterministic tests.
5. Run `pnpm --filter @siqshift/api test -- app.test.ts auth.test.ts`, then the package typecheck.
6. Commit as `feat(api): add secure authentication boundary`.

### Task 4: Timer and project services

**Files:**
- Create: `apps/api/src/repositories.ts`
- Create: `apps/api/src/services/projects.ts`
- Create: `apps/api/src/services/sessions.ts`
- Create: `apps/api/src/routes/projects.ts`
- Create: `apps/api/src/routes/sessions.ts`
- Create: `apps/api/src/drizzle-repositories.ts`
- Test: `apps/api/src/services/projects.test.ts`
- Test: `apps/api/src/services/sessions.test.ts`
- Test: `apps/api/src/routes/sessions.test.ts`

**Steps:**
1. Add service tests for active membership filtering, inaccessible projects, idempotent client UUID starts, duplicate running sessions, archived projects, stop timestamp validation, idle subtraction, 12-hour review marking, duplicate stops, and current-session recovery.
2. Run focused service tests and verify the expected missing-module failures.
3. Define narrow repository interfaces and implement the minimal project/session services to make fake-repository tests pass.
4. Add authenticated Hono routes for listing projects and starting, stopping, and reading the current session; validate all input with shared schemas.
5. Implement transaction-safe Drizzle repositories and map unique-index conflicts to stable `409` errors.
6. Run all API tests and typecheck; commit as `feat(api): add manual timer workflow`.

### Task 5: Reports and CSV export

**Files:**
- Create: `apps/api/src/services/reports.ts`
- Create: `apps/api/src/routes/reports.ts`
- Create: `apps/api/src/csv.ts`
- Test: `apps/api/src/services/reports.test.ts`
- Test: `apps/api/src/routes/reports.test.ts`
- Test: `apps/api/src/csv.test.ts`

**Steps:**
1. Add tests for organization/user/project scoping, inclusive date filters, duration totals, CSV escaping, safe filenames, and spreadsheet-formula neutralization.
2. Run focused tests and verify they fail for missing report modules.
3. Implement parameterized report queries behind a report repository, thin JSON routes, and a streaming-safe CSV response.
4. Run API tests and typecheck; commit as `feat(api): add scoped time reports`.

### Task 6: React timer interface and recovery orchestration

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/vite.config.ts`
- Create: `apps/desktop/index.html`
- Create: `apps/desktop/src/main.tsx`
- Create: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/styles.css`
- Create: `apps/desktop/src/timer-machine.ts`
- Create: `apps/desktop/src/bridge.ts`
- Test: `apps/desktop/src/timer-machine.test.ts`
- Test: `apps/desktop/src/App.test.tsx`

**Steps:**
1. Add pure state-machine tests for start, stop, reconciliation, pending sync, auth expiry, conflict, and elapsed display.
2. Run focused tests and confirm they fail because the UI/state modules are missing.
3. Implement the reducer/state machine and a typed Tauri bridge; then run focused tests to green.
4. Add an accessible compact timer UI for sign-in, project selection, description, running time, stop, recovery/conflict, and pending-sync status.
5. Add Testing Library tests for keyboard/label access, loading/error states, start/stop, recovery, and pending sync.
6. Run desktop tests, typecheck, and production web build; commit as `feat(desktop): add manual timer interface`.

### Task 7: Tauri host, secure storage, tray, and retry queue

**Files:**
- Create: `apps/desktop/src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/tauri.conf.json`
- Create: `apps/desktop/src-tauri/capabilities/default.json`
- Create: `apps/desktop/src-tauri/src/main.rs`
- Create: `apps/desktop/src-tauri/src/lib.rs`
- Create: `apps/desktop/src-tauri/src/api.rs`
- Create: `apps/desktop/src-tauri/src/recovery.rs`
- Create: `apps/desktop/src-tauri/src/monitoring.rs`
- Test: inline Rust unit-test modules in `api.rs`, `recovery.rs`, and `monitoring.rs`

**Steps:**
1. Add Rust tests for reconciliation cases, bounded pending-stop queue, retry preservation, elapsed calculations, and disabled monitoring traits.
2. Run `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` and verify compilation/tests fail before implementation.
3. Implement typed Tauri commands; store bearer tokens with the OS credential store and recovery/settings only with the Tauri store plugin.
4. Implement API calls with redacted errors, exact idempotency payload retries, tray show/hide/quit behavior, and startup-at-login disabled by default.
5. Run `cargo fmt --check`, `cargo test`, and `cargo check`; commit as `feat(desktop): add secure tauri host`.

### Task 8: End-to-end verification and handoff

**Files:**
- Modify: root package scripts as needed
- Create: `.env.example`
- Create: `apps/api/src/smoke.integration.test.ts`
- Modify: `.gitignore`

**Steps:**
1. Add a smoke test that migrates a disposable Neon database, seeds one organization/user/project, logs in, starts a session, reads it, stops it, and exports a report.
2. Run the smoke test once before its last missing wiring change and confirm the expected failure, then implement the minimal wiring and rerun it to green.
3. Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
4. Run database integration and API smoke tests against a disposable Neon branch; never write its connection string to tracked files or logs.
5. Run Rust formatting, tests, checks, and `pnpm --filter @siqshift/desktop tauri build` when the Rust/MSVC toolchain is available.
6. Review the diff for scope, security, secret exposure, dead code, and generated artifacts.
7. Fetch and rebase onto `origin/main`, rerun the full verification commands, then invoke `/finalize` to open the PR.
8. Remove the session worktree only after the PR succeeds.
