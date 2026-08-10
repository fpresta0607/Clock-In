# Clock-In Phase 3 Implementation Plan

**Goal:** Browser attribution that passes the grandmother test — a browser extension matching user-answered URL rules at the edge and reporting verdicts only, over a native-messaging host into the existing agent-session pipeline — plus the monitor precision fixes attribution depends on, signed installers, and auto-update.

**Architecture:** Per `docs/plans/2026-08-09-phase-3-design.md`. Browser spans are agent sessions with `source: "browser"`; rules live in `project_path_mappings` with a `kind` discriminant and are created by answering suggestions, never by typing patterns; the host is a third bin target over the shared spool module; all user-facing setup is automatic or one button.

**Tech Stack:** unchanged (TypeScript 5, pnpm, Vitest, Zod, Drizzle/PostgreSQL, Hono, React 19, Vite, Tauri 2, Rust) plus the Tauri updater plugin and Chrome MV3 APIs.

**Working agreements:** test-first per package conventions; no git commits unless the user asks; Rust changes keep `cargo test`/`cargo fmt --check`/clippy green. **Start signing procurement immediately** (Windows OV/EV certificate, Apple Developer enrollment) — identity verification has days-to-weeks of lead time and Task 9 blocks on it; everything else proceeds in parallel.

---

### Task 1: Shared contracts

**Files:**
- Modify: `packages/shared/src/contracts.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/contracts.test.ts`

**Steps:**
1. Tests first: `agentSourceValues` gains `"browser"`; `agentSessionEventSchema` gains optional `ruleId: uuid` with a refinement requiring exactly one of `cwd`/`ruleId` (`ruleId` iff source is `browser`); mapping schemas gain `kind: "path_prefix" | "url_rule"` (create defaults to `path_prefix`) and URL-rule pattern validation (scheme-less, lowercase host, single trailing glob, ≤500 chars); `meStatsResponseSchema` gains `sites: array({ mapping: { id, pattern, projectId nullable }, durationSeconds })`.
2. Implement, run shared tests and typecheck.

### Task 2: Database

**Files:**
- Modify: `packages/database/src/schema.ts`
- Create: `packages/database/migrations/0007_browser_attribution.sql`
- Test: `packages/database/src/schema.test.ts`, `packages/database/src/migrations.integration.test.ts`

**Steps:**
1. Tests for: `agent_source` enum containing `browser`; `project_path_mappings.kind` (`path_prefix` default, not null) with the existing `(org, user, pathPrefix)` uniqueness now spanning both kinds.
2. Migration: `ALTER TYPE agent_source ADD VALUE 'browser'` (Neon is PG15+; fine in-transaction as long as the value is not used in the same migration) and the `kind` column. No new tables.
3. Package tests; integration suite against a disposable Neon branch.

### Task 3: API — ruleId attribution, per-source reaping, sites

**Files:**
- Modify: `apps/api/src/services/agent-sessions.ts`, `apps/api/src/services/attribution.ts`, `apps/api/src/services/reports.ts`, `apps/api/src/services/path-mappings.ts`
- Modify: `apps/api/src/repositories.ts`, `apps/api/src/drizzle-repositories.ts`, `apps/api/src/routes/me-stats.ts`
- Tests beside each

**Steps:**
1. Service tests: a `browser` event resolves `ruleId` against the caller's `url_rule` mappings (live rule → project; deleted/foreign rule → unattributed, not an error); reaper windows become per-source (`browser` 10 minutes, others 6 hours); browser sessions are excluded from the corroboration union (assert existing corroboration fixtures byte-identical) while still linking to running timers and feeding mismatch review; path-mapping CRUD validates `url_rule` patterns and keeps membership checks.
2. `sites` aggregation: per-rule browser-span totals clipped to the caller's fresh `active` segments, in the report repository; exposed on `/me/stats`.
3. Route tests for the extended contracts; full API suite and typecheck.

### Task 4: Monitor precision (Rust)

**Files:**
- Modify: `apps/desktop/src-tauri/src/monitor.rs`
- Test: inline modules

**Steps:**
1. Pure tests with injected sources/clocks: a foreground-change event closes the open `active` segment and opens a new one (per-app time no longer inherits the last label); joint wall+monotonic jump beyond two poll intervals synthesizes `Suspended` for the gap; wall-only jump splits the open segment at the jump and raises a clock-change notice in `MonitorStatus`; `WTS_CONSOLE_DISCONNECT`/`WTS_REMOTE_DISCONNECT` map to `Locked`.
2. Windows side: `SetWinEventHook(EVENT_SYSTEM_FOREGROUND, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS)` on the existing hidden-window thread, pushing into `PlatformEvents`; `ApplicationFrameHost.exe` resolved via the child `Windows.UI.Core.CoreWindow` PID; the two disconnect arms in the window proc; monotonic reading recorded beside `unix_now` each tick.
3. `cargo fmt --check`, `cargo test`, clippy.

### Task 5: `clock-in-browser-host`

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml` (third `[[bin]]`)
- Create: `apps/desktop/src-tauri/src/bin/clock-in-browser-host.rs`, `apps/desktop/src-tauri/src/native_messaging.rs`
- Test: inline modules plus a CLI test beside `tests/hook_cli.rs`

**Steps:**
1. Tests: 4-byte length-prefixed JSON framing both directions with a 64 KB cap (oversize and truncated frames dropped without killing the loop); `get-rules` replies with the rules file's contents (missing/unparseable file → empty rule set — fails closed); `span-event` messages append to `browser-spool.jsonl` via the shared `spool` module under the interprocess lock; unmatched-origin tally requests pass through read-only; unknown message types ignored.
2. Implement the host as a stdin/stdout loop over `native_messaging.rs`. No network, no credentials, no sockets.

### Task 6: Browser extension

**Files:**
- Create: `apps/browser-extension/` (package.json, tsconfig, vite config, MV3 manifest + Firefox variant)
- Create: `src/matching.ts`, `src/spans.ts`, `src/tally.ts` (pure), `src/background.ts` (chrome adapters), tests beside each

**Steps:**
1. Pure-module tests: longest-wins case-insensitive-host matching with glob bounds; the span state machine over injected clock/event streams: 15 s dwell to open, sub-15 s gaps merge, `ended` on tab switch/blur/idle/lock, heartbeat every 60 s; unmatched eTLD+1 tally accumulation and clearing; a bounded offline outbox that pauses capture rather than dropping saved evidence when the host is unreachable.
2. `background.ts`: `tabs.onActivated`/`tabs.onUpdated`/`windows.onFocusChanged`/`idle.onStateChanged` feeding the state machine; `connectNative` with reconnect backoff; rules fetched on connect and every 5 minutes. URLs never leave this package's process — events carry `ruleId`, span id, timestamps only.
3. Wire the package into the workspace (`pnpm test`/`typecheck`/`build` recursively); produce the Chrome/Edge zip and Firefox variant as build outputs.

### Task 7: Desktop — onboarding, registration, suggestions, updater

**Files:**
- Modify: `apps/desktop/src-tauri/src/monitor.rs` (registration + rules writer + browser-spool drain), `src/lib.rs` (commands), `src/uploader.rs`
- Modify: `apps/desktop/src/App.tsx`, `src/bridge.ts`, `src/timer-machine.ts`; tests beside each
- Modify: `apps/desktop/src-tauri/tauri.conf.json` (updater)

**Steps:**
1. Rust tests: silent idempotent registration writes per-browser HKCU keys + host manifest (`allowed_origins` pinned) for detected browsers, repairs on launch, and reports per-browser health (`never-registered` / `binary-missing` / `connected`); the rules file is rewritten from cached mappings whenever they change; the uploader drains `browser-spool.jsonl` on the existing cadence; suggested-start requires a 60 s-old browser span and never suppresses away handling (`agent_active` excludes `browser`).
2. Pattern generation as a pure module with tests: origin → whole-site rule by default; path-narrowed question for the multi-project host list (github.com, gitlab.com, bitbucket.org, linear.app).
3. React tests: onboarding flow (sign-in → "Track your work time on this computer? [Turn on]" → browser cards flipping to connected on handshake); the suggestion question creating a rule via one click and the never-suggest path; **[Fix]** invoking the repair command; the Advanced disclosure hiding thresholds, path prefixes, raw patterns, and agent hooks (hooks rendered only when a CLI is detected); prompt copy matching the design's question-plus-default format.
4. Updater: `tauri-plugin-updater` with the release pipeline's public key; update check on launch, install on quit.
5. Desktop tests, typecheck, build; Rust gates.

### Task 8: Release pipeline and store packaging

**Files:**
- Modify: `.github/workflows/release.yml`, `.github/workflows/ci.yml`, `DEPLOY.md`

**Steps:**
1. Wire Windows signing and macOS notarization secrets into `tauri-action`; sign all three binaries (app, `clock-in-hook`, `clock-in-browser-host`); publish updater artifacts beside installers.
2. CI builds the extension package and uploads the store zip as an artifact; DEPLOY.md gains the Web Store (unlisted) and Edge Add-ons submission steps and their review-latency caveat.

### Task 9: End-to-end verification

**Steps:**
1. Extend the smoke test: upload a synthetic browser-span event with a live `url_rule` → verify attribution, timer linking, `sites` on `/me/stats`, and unchanged corroboration totals.
2. Full gate: `pnpm typecheck && pnpm test && pnpm build`, Rust fmt/clippy/test, and a production Tauri build with the required signing credentials.
3. Review the diff for privacy posture (no URL leaves the extension; tally and never-suggest list local-only) and scope.

## Manual verification checklist (post-build, real machine)

1. **Grandmother pass (run first, run last):** a non-technical person goes from the dashboard's Download button to a running, browser-connected timer with no coaching. Every stall, question, or misread is filed as a bug against the design.
2. **Signed install:** no SmartScreen interstitial on Windows; macOS opens without right-click ceremony.
3. **First run:** sign-in → one toggle → browser cards; installing the extension from the store flips the card to "connected ✓" unaided.
4. **Suggestion loop:** dwell on an unmapped site past the tally threshold → the plain-language question appears; *Yes* creates the rule and subsequent dwell produces attributed spans; *No — don't ask again* silences that origin; network inspector confirms no origin is ever uploaded.
5. **Glance vs. dwell:** 14 s on a mapped tab → no span; 20 s → span; rapid tab flips merge; going idle or locking ends the span.
6. **Suggested start:** 60 s on a mapped tab with no timer → "Working on ⟨project⟩? [Start timer] [Not now]"; away auto-stop still fires with only a browser span open (no agent override).
7. **Precision:** switch apps mid-active-span and confirm per-app stats split at the switch; UWP apps report their own names; sleep a Modern Standby laptop and confirm a `Suspended` gap, not a giant idle; change the system clock and confirm the split plus the status notice.
8. **Repair:** delete a registry key → relaunch repairs silently; rename the host binary → the card shows one sentence and [Fix], and [Fix] fixes it.
9. **Update:** install version N, publish N+1, confirm the app updates itself without user action beyond restart.
10. **Incognito:** mapped site in an incognito window produces nothing.
