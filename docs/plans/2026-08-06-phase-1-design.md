# SIQshift Phase 1 Design

## Scope

Phase 1 delivers the complete manual timer path: authenticated users can list their shared projects, start exactly one session, stop it, recover it after a restart, and inspect or export basic project, user, and organization reports. The Windows desktop behaves as a tray utility and keeps only recovery state locally. Activity, lock, sleep, and process monitoring remain disabled behind stable Rust traits.

## Chosen approach

Use a plain pnpm workspace rather than Turborepo. The repository is new, and package-level scripts plus pnpm's recursive runner provide the required development commands with less setup.

Use Hono on Node.js with a conventional service/repository split. Hono routes validate Zod contracts from `packages/shared`; services enforce authorization and timer rules; Drizzle repositories own PostgreSQL access. This keeps routes thin and permits deterministic service and HTTP tests without a live cloud database, while a dedicated PostgreSQL integration suite verifies migrations and database invariants when `TEST_DATABASE_URL` is provided.

Use a Tauri command boundary for all desktop network and secret-storage operations. Rust retrieves the API token from the operating-system credential store and sends authenticated requests through `reqwest`; React never persists tokens. `tauri-plugin-store` holds only the active-session recovery record, settings, and a bounded pending-stop queue.

## Alternatives considered

1. Turborepo orchestration would improve caching in a larger monorepo, but adds configuration without material Phase 1 benefit.
2. Direct browser-side API calls would reduce Rust code, but would expose bearer-token handling to the webview and complicate secure credential storage.
3. A mock database or SQLite test substitute would make tests easier, but would fail to validate PostgreSQL behavior. Unit tests will use explicit repository fakes; database integration tests will target PostgreSQL only.

## Package architecture

- `packages/shared`: Zod schemas, inferred API types, session status constants, and time-format helpers shared by API and React.
- `packages/database`: Drizzle tables, PostgreSQL migrations, production connection factory, migration runner, and seed command.
- `apps/api`: environment validation, Hono composition, security middleware, JWT authentication, services, Drizzle repositories, reports, CSV generation, and tests.
- `apps/desktop`: React timer UI plus Tauri 2 host, tray integration, API client, secure credentials, recovery store, retry orchestration, and future-monitoring traits.

## Data and request flow

Login returns a short-lived access token. Rust stores it in the OS credential store and keeps only the current authenticated user in memory. Start creates a UUID on the desktop, persists an unconfirmed recovery record first, then calls the API. The API derives user and organization from the JWT, verifies project membership and activity, and inserts idempotently. A successful response marks the recovery record server-confirmed.

Stop captures the requested stop timestamp and idle exclusion, updates local state to stopping, and calls the API. The server locks and validates the user's running session, calculates duration from timestamps, marks sessions over 12 hours `needs_review`, and returns the persisted result. On a transient failure, the desktop removes the visible running timer, queues the exact idempotent stop operation, and reports pending sync. Successful retries remove the operation.

At launch the desktop loads recovery state and asks the server for the running session. Matching state is restored, server-only state is adopted, and an unconfirmed local start is retried. Conflicting state is surfaced for user review; it is never silently discarded.

## Security and privacy

Passwords use Argon2id. JWT signing secrets and database credentials exist only in the API environment. API input is validated at every route, CORS is allowlisted, request bodies are bounded, security headers are set, and login is rate-limited. Authorization is applied in services and reporting queries. Logs redact tokens, passwords, descriptions, and process details. No Phase 1 component collects activity telemetry.

## Error handling

Shared API errors use stable codes and actionable messages. Expected conflicts such as an existing running timer return `409`; authentication failures return `401`; inaccessible resources return `404` to avoid leaking membership; invalid timestamps return `400`. The desktop maps transient failures to pending sync and authentication failures to a sign-in-required state.

## Testing and verification

Shared schemas receive unit tests. API services and routes receive behavior tests for authentication, authorization, idempotent start, duplicate running sessions, stop duration and idle subtraction, duplicate stop handling, archived projects, filtering, and reporting. PostgreSQL integration tests cover migrations and the partial unique index when a test URL is available. React Testing Library covers timer controls, recovery, elapsed display, and pending sync. Rust pure tests cover reconciliation, retry queue behavior, state transitions, and elapsed calculations.

Verification runs formatting, linting, type checking, unit tests, production builds, Rust formatting/tests/checks, PostgreSQL migrations, an API smoke test, and a Tauri desktop build. Migration and end-to-end claims require a reachable PostgreSQL database; Rust and native Windows build tools must be installed before desktop verification can pass.

## Deliberate limitations

- No activity monitoring, process tracking, lock/sleep handling, automated updates, or administrative management UI.
- Logout removes the local bearer token; Phase 1 does not maintain server-side refresh-token revocation state.
- Session editing is limited to the required authenticated API contract and is not exposed as a full desktop administration workflow.
- Startup-at-login is visible and user-controlled, but disabled by default.
