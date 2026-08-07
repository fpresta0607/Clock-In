# Clock-In Phase 2 Design

## Scope

Phase 2 turns the manual stopwatch into a corroborated tracker. Three signal sources feed the existing session model: operating-system activity (idle, lock, sleep, foreground process), agent CLI sessions (Claude Code, Codex, Kimi Code), and user-confirmed timer actions. The primary goal is **project attribution**: every hour on the leaderboard should name the project it belongs to and carry evidence that real work produced it. Manual time entry stays possible, but uncorroborated time is visibly labeled as such, which removes most of the value of padding.

Out of scope, unchanged from Phase 1: keystroke logging, mouse tracking, screenshots, window titles by default, and any content capture.

## Chosen approach

### Lightweight by construction

The monitor never hooks, injects into, or intercepts another process. It only asks the OS read-only questions on a slow timer:

- One Tokio task wakes every 30 seconds and calls `GetLastInputInfo` (idle seconds) and `GetForegroundWindow` (process name only). No keyboard or mouse hooks, no DLL injection, no ETW, no polling below a 30-second cadence.
- Lock, unlock, suspend, and resume arrive as Windows session events (`WM_WTSSESSION_CHANGE`, power broadcast) on the existing Tauri window — zero background cost between events.
- Agent events are emitted by the agent CLIs themselves when they start and stop work; the desktop adds no per-keystroke or per-file cost.
- Expected footprint: under 1% CPU and a few MB of RAM. All uploads are batched; nothing on the hot path blocks the UI or the monitored machine.

### Signal 1: OS activity monitor (new Rust module `monitor.rs`)

This delivers the "stable Rust traits" Phase 1 deferred:

```rust
enum ActivitySignal {
    Active { process_name: Option<String> },
    Idle { idle_seconds: u32 },
    Locked,
    Suspended,
}

trait ActivitySource {
    fn poll(&self) -> ActivitySignal;               // called on the 30s tick
    fn next_event(&self) -> Option<ActivitySignal>; // lock/suspend, pushed by the window event loop
}
```

The monitor folds the signal stream into coarse **activity segments** (`active`, `idle`, `locked`, `suspended`) with start/end timestamps. Transitions, not ticks, are recorded, so a workday produces dozens of rows, not thousands. Segments land in a bounded in-memory buffer, are appended to a local spool file, and an uploader task batches them to the API every five minutes and at timer stop. The spool survives restarts exactly like the Phase 1 recovery record.

These segments finally populate the existing `idleSeconds` stop field, which Phase 1 hardcoded to 0: when a timer stops, the desktop sums idle/locked overlap and submits it, so server-side `durationSeconds` excludes unattended time automatically.

Known false-idle sources: video calls, watching media, and reading produce no keyboard/mouse input and therefore look idle. The away prompt (below) is the mitigation; detecting call apps by process name is a possible later refinement, not Phase 2.

### Signal 2: agent session hooks

Agent CLIs expose lifecycle hooks; Phase 2 standardizes them into one contract. A tiny standalone binary, `clock-in-hook`, is installed beside the desktop app. Following the Claude Code hook convention, the CLI pipes a JSON event to the binary's **stdin** (flags are a fallback for CLIs that cannot pipe):

```json
{ "version": 1, "source": "claude-code", "event": "session-start",
  "sessionId": "...", "cwd": "C:/dev/Clock-In", "occurredAt": "..." }
```

The binary does one thing — append that line to `%APPDATA%/clock-in/agent-spool.jsonl` under an interprocess file lock (multiple agent processes can fire hooks simultaneously; lock-bounded appends prevent interleaved partial lines) — and exits. It never talks to the network, so a hook can never slow down or block the agent CLI, and events recorded while the desktop is closed are not lost. The spool is capped (default 10 MB) with rotation so a desktop that never runs cannot fill the disk. The desktop drains the spool when running and uploads events with the user's existing session token; no new credential or device auth is introduced.

Per-CLI wiring and capability (verified at implementation time; the contract treats every event as optional per source):

- **Claude Code**: `SessionStart` / `SessionEnd` hooks in `settings.json` — true session boundaries; `PostToolUse` optionally acts as an activity heartbeat.
- **Codex CLI**: the `notify` hook fires on turn completion only, so it provides heartbeats, not boundaries; session start/end are synthesized from heartbeat gaps.
- **Kimi Code**: hooks configured in `config.toml`; exact event coverage must be confirmed against the installed version before wiring.
- Anything else can call the same binary with `--source other`; the contract is the product, not any one CLI.

Because `session-end` is never guaranteed (crash, `kill -9`, or a CLI that cannot emit it), the server reaps agent sessions with no event for a staleness window (default 6 hours) and closes them at the last-seen timestamp. Out-of-order delivery (an end arriving before its start) is tolerated by upsert, not rejected.

Hook registration into each CLI's own config file is performed by an explicit, opt-in setup step in the desktop — the app never rewrites Claude Code/Codex/Kimi configuration silently.

### Project attribution

Attribution is resolved from evidence, not asked of the user each time:

1. A new **project path mapping** table maps a filesystem path prefix (and optionally a git remote URL) to a project, per user per organization. Mappings are created once from the desktop settings UI, which suggests them from recently seen agent working directories.
2. When an agent session event arrives, the API resolves `cwd` against the user's mappings using normalized longest-prefix match (case-insensitive, symlink- and trailing-separator-normalized; WSL paths are normalized to their Windows form where possible). Equal-length ties are rejected as ambiguous and surfaced for explicit mapping. Unmatched directories stay unattributed and appear in a "needs mapping" list — this is the one piece of human input the system asks for.
3. When a timer runs concurrently with attributed agent sessions, the API links them (`agent_sessions.linkedSessionId`). Reports can then break a timer's hours down by what actually happened inside it. A timer whose evidence points at a *different* project than the one selected is surfaced as an attribution mismatch in review, not silently accepted.
4. When an agent session starts in a mapped directory and no timer is running, the desktop prompts: "Kimi Code active in `Clock-In` — start tracking **Project X**?" One click starts a fully attributed timer. This is the hybrid posture: automation proposes, the human confirms. The desktop caches the user's path mappings so the prompt is raised locally from the spool drain, with no server round-trip; the server remains authoritative for stored attribution.

### Hybrid auto start/stop policy

The timer state machine gains prompts, never silent edits:

- **Suggested start**: an attributed agent session starting while no timer runs → tray prompt with project preselected. Nothing starts without a click. (Process-name activity alone cannot trigger suggestions in Phase 2, because a process name carries no project — see Known gaps.)
- **Away handling**: timer running + idle beyond a configurable threshold (default 10 min) → on return, "You were away 23 minutes — discard or keep?" Discard subtracts the span via `idleSeconds`. Away beyond a hard limit (default 60 min) → the timer auto-stops at the last-active timestamp and flags the session for confirmation at next launch, using the existing pending-sync machinery to reach the server.
- **Agent-active override**: while a linked agent session is active, the away auto-stop is suppressed and idle subtraction is paused (default on) — an overnight agent run on an idle, locked machine is legitimate work and must not be auto-stopped or trimmed away. The agent session itself is the corroborating evidence for that span.
- **Lock/sleep**: optional setting to auto-stop on lock or suspend; off by default for the same reason.

Auto-stops always record the evidence that caused them, so every automatic action is explainable in the UI and reversible through the existing session-edit API.

### User visibility: is it running, and what did I do?

Tracking that the user cannot see is surveillance; tracking the user can interrogate is a tool. Phase 2 makes state and stats first-class:

- **Always-on status.** The tray icon encodes the full state — signed out, idle, timer running, timer running with monitoring active, monitoring paused — and its tooltip shows the current session's project and elapsed time. The React header mirrors it. There is no state in which the monitor records without the UI saying so, and no state in which a paused monitor looks active.
- **Monitor health at a glance.** A status line answers "is it actually working?": last successful upload, spool backlog count, activity-monitor running/paused, and per-CLI hook registration status (detected by the setup wizard and re-checked on launch, so a Claude Code settings update that removed the hook is noticed).
- **Live session stats.** The current-session card shows elapsed time, idle trimmed so far, corroborated seconds so far, and linked agent sessions with their resolved projects. These numbers are computed locally from the monitor's segment buffer, so they are instant and available offline.
- **Personal history.** A stats view shows today/this week per project with the corroborated/uncorroborated split, session counts, and the user's own recent session rows. A new `GET /v1/me/stats` endpoint returns per-project totals for a date range; it is the reporting service's corroboration math scoped to the caller, not a separate computation, so the user always sees the same evidence and the same numbers the org's reports will show. Nothing about the user's own data is manager-only.

### Design language

All Phase 2 UI — status surfaces, live session card, personal stats view, settings, prompts — uses the SIQstack brand system already defined in `apps/web/src/styles.css`: body `#03050a`, chromatic glass cards (green/blue gradient fill, `rgba(0,229,155,…)` borders, backdrop blur), accent green `#00e59b` / deep `#00c97f` / mint `#6ee7b7`, secondary text `#a3b3c2`, Inter, pill buttons, uppercase eyebrow labels, tabular numerals for every time figure. The tokens move from `apps/web/src/styles.css` into a shared stylesheet in `packages/shared` that both apps import, so the brand is edited once.

The desktop's Phase 1 "chronometer" theme (graphite/ivory/amber, Bahnschrift, 2px corners) is retired in favor of this single system — desktop and web should read as one product, and two themes inside one tray app would be incoherent. The WebGL sine-wave shader stays web-only: a GPU background in an always-running tray utility violates the lightweight principle. Display conventions for the new data: corroborated time renders in mint, uncorroborated in secondary gray, and agent-linked spans carry a small source badge (Claude Code / Codex / Kimi Code).

### Anti-manipulation stance

The design assumption: a determined user can forge client-side evidence (the spool is a local file), so Phase 2 does not attempt cryptographic proof. Instead it makes honest use effortless and padding visible:

- The server records `receivedAt` on every segment and agent event. Evidence uploaded more than 7 days after `occurredAt` — the same bound Phase 1 applies to backdated starts — is stored but excluded from corroboration, so history cannot be backfilled after the fact. The window is deliberately days, not hours: a laptop offline for a long weekend must still be able to corroborate honest work when it reconnects.
- Reports and the leaderboard distinguish **corroborated seconds** — time overlapping `active` segments or linked agent sessions — from uncorroborated time. Manual or uncorroborated entries still count, but they read differently next to verified ones.
- The Phase 1 guardrails stay: starts backdate at most 7 days, stops cannot be in the future, sessions over 12 hours are flagged `needs_review`, one running timer per user.
- Fabrication requires sustained, deliberate effort and leaves statistical fingerprints (activity at 3 a.m. every day, 100% active segments), which the review flag and reports are positioned to catch.

## Alternatives considered

1. **Fully automatic tracking** (no manual timer) was rejected: idle detection cannot distinguish "thinking about work" from "making coffee", and silently started timers would destroy trust in the numbers. Suggestions plus one-click confirm gets most of the convenience with none of the false positives.
2. **Keylogger-grade activity tracking** (input hooks, window titles, screenshots) was rejected: it violates the Phase 1 privacy posture, is legally fraught on employee machines, and its fine-grained data does not improve project attribution over coarse segments plus agent sessions.
3. **A localhost HTTP endpoint on the desktop for agent hooks** was rejected as the sole channel: hooks would fail silently when the desktop is not running, and an open local port expands the attack surface. The append-only spool file is dumber and strictly more reliable; a localhost endpoint may be added later for live prompts.
4. **Server-side corroboration computation at report time** was kept over client-computed "verified seconds": the desktop submits raw evidence, the API computes overlap, so the number a manager sees is derived from stored rows rather than a self-reported figure.

## Package architecture

- `packages/shared`: contracts for activity-segment batch upload, agent-session events, path-mapping CRUD, the personal stats response, corroboration fields on report rows and leaderboard entries, and the shared SIQstack brand token stylesheet consumed by both frontends.
- `packages/database`: new tables `activity_segments`, `agent_sessions`, `project_path_mappings`; migrations; no changes to `time_sessions` columns (Phase 2 stores evidence beside sessions, not inside them).
- `apps/api`: three new route groups (`/v1/activity/segments`, `/v1/agent-sessions`, `/v1/path-mappings`), a `/v1/me/stats` endpoint reusing the reporting service's corroboration math scoped to the caller, prefix-match attribution in a new attribution service, `receivedAt` freshness enforcement.
- `apps/desktop`: `monitor.rs` (activity traits, segment builder, spool, uploader), the `clock-in-hook` binary target, new timer-machine states for suggested start and away handling, tray icon and tooltip states for timer and monitoring status, a monitor-health status line, live session stats computed from the local segment buffer, a personal stats view backed by `/v1/me/stats`, a settings UI for thresholds, path mappings, and lock/sleep policy, an opt-in hook-registration wizard, and a "what's recorded" privacy panel. All surfaces are restyled on the shared SIQstack tokens, retiring the Phase 1 chronometer theme.

## Data and request flow

**Activity segments.** The monitor detects a transition, appends a segment locally, and the uploader POSTs batches with client-generated UUIDs. The API inserts idempotently on `(organizationId, userId, clientId)` — the same idempotency pattern Phase 1 uses for session start — and stamps `receivedAt`. Segments are semantically validated server-side: `endedAt` after `startedAt`, not beyond the future tolerance, and capped at a sane maximum span, with invalid rows rejected per-row rather than failing the batch. At timer stop the desktop includes the measured `idleSeconds` as before; the server validates it against elapsed time exactly as it does today.

**Agent sessions.** `clock-in-hook` appends to the spool; the desktop drains it, raises any start suggestions locally from cached mappings, and uploads. A `session-start` upserts a running agent session keyed on `(organizationId, userId, source, externalSessionId)`; `session-end` closes it. On start, the attribution service resolves `cwd` to a project. If the user has a running timer for that project, the API links the rows.

**Reports.** The reporting service computes corroborated seconds per session as the overlap between `[startedAt, stoppedAt - idle]` and the union of the user's fresh `active` segments and linked agent sessions, capped at duration. Leaderboard entries and report rows gain `corroboratedSeconds`; totals gain a corroborated/uncorroborated split.

## Security and privacy

The privacy posture is tightened, not loosened, and stays user-visible:

- Only process names are sampled; window titles are off by default and require an explicit org-level setting. No URLs, no document names, no input content.
- Agent events carry `cwd`, which may contain a user name in the path; it is stored for attribution and shown only to the owning user and org admins. It is redacted from logs like descriptions are today.
- Every stored signal is inspectable in the desktop's "what's recorded" panel, and monitoring can be paused without stopping the timer (which simply makes that time uncorroborated).
- `clock-in-hook` holds no credentials and opens no sockets; the spool file is the only interface. The API surface gains no unauthenticated endpoints. The binary must be code-signed with the same certificate as the desktop installer so antivirus and SmartScreen do not flag a hook that fires on every agent action.
- Rate limits extend to the batch upload routes; batch size and body limits follow the Phase 1 bounds.
- Deployment on company machines requires an org-level policy switch and employee disclosure; monitoring defaults to off until the org enables it. Consent and works-council requirements vary by jurisdiction and are the deploying company's obligation, not the software's.

## Error handling

Spool files are append-only and drained transactionally: uploaded lines are acknowledged before truncation, so a crash mid-upload replays rather than loses evidence, and idempotent server keys make the replay safe. A spool line that fails to parse is quarantined, not fatal. Attribution misses are not errors — they produce "needs mapping" entries. Malformed hook invocations exit non-zero with a message the agent CLI surfaces, and never write partial lines.

## Testing and verification

Pure-Rust tests cover the segment builder (signal stream in, segments out), spool append under concurrent writers, drain/replay, away-threshold decisions, and the agent-active override, with the clock and activity source injected as traits. Shared-schema tests cover the new contracts. API service tests cover idempotent segment upload, segment validation, prefix-match attribution (longest match wins, normalization, ties rejected), agent-session upsert including out-of-order end-before-start, staleness reaping, `receivedAt` freshness exclusion, and corroboration overlap math. React tests cover the suggested-start prompt, away prompt, tray/status states, live session stats, the personal stats view, hook-registration wizard, and settings UI; API route tests cover `/v1/me/stats` scoping (a user never sees another's numbers). Verification adds the `clock-in-hook` binary to the desktop build and runs a synthetic hook event end to end against a test database.

## Known gaps and open questions

Accepted in this design; each is a candidate for a later phase:

- **Segment-level project attribution**: agent sessions know their project, but plain process activity does not (VS Code's workspace, a browser tab's site). Phase 2 corroborates "the machine was working"; per-project attribution of non-agent activity needs editor/workspace detection later. Consequently, suggested start only fires from agent sessions, not from raw process activity.
- **Concurrent agent sessions across two projects**: one running timer per user means only one can be linked. Overlapping agent sessions in different projects are stored and flagged for review; splitting one timer's span across projects is out of scope.
- **Browser-based work** (webmail, GitHub, docs) registers only as "active" — no URLs or titles by design. This is the accepted trade-off for the privacy posture.
- **Corroboration cost at scale**: overlap computation at report time is fine at Phase 1/2 volumes; large organizations may need materialized per-session corroboration maintained at upload time. The contract carries `corroboratedSeconds` either way, so the storage strategy can change underneath it.
- **Windows-only**: the `ActivitySource` trait admits macOS/Linux implementations later, but Phase 2 ships Windows only.
- **Per-CLI hook asymmetry**: only Claude Code has true session boundaries today; Codex contributes heartbeats and Kimi Code's event coverage is to be confirmed. Attribution quality therefore varies by source until those CLIs mature.
- **Shared machines**: two Windows users on one PC produce two device streams; fast-user-switching mid-timer behaves as "locked" for the switched-out session. A shared single sign-on machine is not supported.

## Deliberate limitations

- Corroboration is overlap-based, not semantic: the system verifies that the machine was active or an agent was running, not what the human was thinking.
- Evidence can be forged by a determined user; Phase 2 raises the cost and visibility of padding rather than making it impossible.
- Agent token usage and files-touched statistics are not collected in Phase 2; agent sessions record time and attribution only.
- Cross-device overlap (two machines active at once for one user) is stored faithfully; reconciling it into reports is left for a later phase.
- Mobile and web tracking remain out of scope; signals come from the Windows desktop only.
