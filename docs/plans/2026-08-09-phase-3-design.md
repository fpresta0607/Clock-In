# Clock-In Phase 3 Design

## Scope

Phase 3 closes the two accuracy gaps Phase 2 accepted: browser-based work registers only as "active (chrome.exe)" with no project, and the activity monitor's 30-second sampling misattributes per-app time. It delivers **browser attribution** — a browser extension that resolves the active tab against user-defined URL rules and reports only the verdict — plus the **monitor precision groundwork** that attribution depends on: event-driven foreground tracking, UWP process resolution, clock-gap sleep detection, and session-disconnect handling.

The privacy posture is unchanged and load-bearing: full URLs, page titles, and browsing history never leave the browser process. What crosses the boundary is "rule N matched from 14:02 to 14:31" — and rules are created from the user's own answers.

Phase 3 also carries a usability gate it must not ship without: setup and daily use must pass the grandmother test defined below - signed external installers, auto-update, silent plumbing, and question-driven configuration. The exact signing and updater policy lives in `DEPLOY.md`. This phase points the product at non-engineers for the first time, so it is the phase where "works if you read the docs" stops being acceptable.

Out of scope, unchanged: keystroke logging, screenshots, window titles, input content, network-level inspection, macOS/Linux monitoring, mobile.

## Chosen approach

### The grandmother test

Phase 3 adds the product's most technical machinery — an extension, native messaging, URL rules — and must therefore be its least technical to use. The gate for every user-facing surface in this phase: a person who has never heard of a registry key, a glob, or an extension store must be able to install Clock-In, connect their browser, and answer its questions unaided. Concretely: every setup step is either automatic or a single labeled button; nothing ever requires typing syntax; every prompt is a plain-language question with a highlighted default; every failure surfaces as one sentence and a **[Fix]** button that performs the repair itself, never instructions to follow. Copy targets a reading level, not a technology level: "Chrome is connected", never "native messaging host registered".

The gate forces three requirements that were previously deferred:

- **Code-signing support ships in this phase.** An unsigned installer greets a novice with "Windows protected your PC" and a hidden "Run anyway" - that is where their setup ends. Windows signing and macOS notarization (priced in DEPLOY.md) are required for non-engineer distribution. `clock-in-hook` and `clock-in-browser-host` sign with the same certificate.
- **Auto-update via the Tauri updater**, fed by the existing GitHub Releases pipeline. Install once; no user is ever asked to re-download anything.
- **Progressive disclosure.** The default settings screen is three plain toggles. Agent hooks appear only when an agent CLI is detected on the machine; thresholds, path prefixes, and raw rule patterns live behind an "Advanced" disclosure. An engineer loses nothing; everyone else never sees it.

### Setup and first run

The complete path from nothing to tracking, as the user experiences it:

1. Dashboard → **Download** → run the signed installer for external distribution.
2. The app opens to one sign-in form — the same email and password as the dashboard.
3. One question: "Track your work time on this computer?" **[Turn on]** — the monitoring opt-in as a sentence, not a settings hunt.
4. One card per detected browser: **[Connect Chrome]** opens the extension's store page; when the extension connects, the card flips to "Chrome is connected ✓" on its own.

That is the entire ceremony: sign in, two buttons. Native-messaging host registration happens silently at first run for every detected browser and is re-checked and repaired on every launch — unlike agent-hook registration, which edits *another tool's* config and rightly stays opt-in, these HKCU keys are Clock-In's own, need no elevation, and are inert until the user installs the extension, so writing them needs no ceremony. Consent lives in step 3's toggle and, for the extension, in the opt-out toggle for its automatic force-install (the store install is now automatic for Chrome/Edge; Firefox keeps the manual flow).

### Monitor precision groundwork

Four fixes to `monitor.rs`, all inside the existing trait/test structure. They are in this phase because browser attribution's honesty depends on them: a browser span only counts where it overlaps an `active` segment *whose process is that browser*, so per-process segment boundaries must be real.

1. **Event-driven foreground changes.** `SetWinEventHook(EVENT_SYSTEM_FOREGROUND, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS)` registered on the existing hidden-window thread (the hook requires a message loop; we have one). A foreground change closes the open `active` segment and opens a new one, so per-app time stops being "whatever was foreground last before idle". The 30-second poll remains the idle/active authority; the hook only sharpens process boundaries. Out-of-context delivery is not injection — events arrive over our own message loop.
2. **UWP resolution.** When the foreground process is `ApplicationFrameHost.exe`, enumerate child windows for the `Windows.UI.Core.CoreWindow` and take its PID. Otherwise every Store-packaged app (Calculator, Photos, new Outlook) reports as ApplicationFrameHost.exe.
3. **Clock-gap sleep and clock-change detection.** Each tick records wall time (`unix_now`) beside a monotonic reading. Both jumping together beyond two poll intervals means the machine slept without delivering `PBT_APMSUSPEND` — the normal case on Modern Standby hardware — and the gap is synthesized as a `Suspended` segment. Wall time jumping alone means the system clock changed: the open segment is split at the jump and the segment is flagged, which also closes the evidence-forging hole of backdating via the system clock (spooled timestamps are wall-clock today).
4. **Disconnect events.** The window proc gains `WTS_CONSOLE_DISCONNECT` and `WTS_REMOTE_DISCONNECT` arms mapping to `Locked` — fast user switching and RDP takeover, which the Phase 2 design claimed behaved as locked but the code never implemented. Reconnect raises no event; the next poll closes the span, same as unlock.

### Signal 3: browser attribution

A Manifest V3 extension (Chrome and Edge from one build; Firefox from a thin variant) watches `tabs.onActivated`, `tabs.onUpdated` (URL changes in the active tab), `windows.onFocusChanged`, and `idle.onStateChanged`. It talks to a native messaging host — `clock-in-browser-host`, a sibling binary of `clock-in-hook` — over the browser's sanctioned stdio channel (4-byte length-prefixed JSON; ours capped at 64 KB per message). The browser launches the host itself when the extension connects; the host holds no credentials, opens no sockets, and has exactly two jobs: serve the current rule set to the extension, and append verdict events to a browser spool with the same interprocess-lock, rotation, and drain discipline as the agent spool. The desktop drains both spools on the existing uploader cadence.

Registration is silent and idempotent, per "Setup and first run": per-browser HKCU registry keys pointing at a host manifest whose `allowed_origins` pins the extension ID, written at first run and repaired on launch. The status line gains per-browser badges beside the per-CLI hook badges; a broken registration shows one sentence and a **[Fix]** button that re-registers, and a browser card that never completes its handshake keeps offering **[Connect Chrome]** rather than reporting an error state the user must interpret.

### Match rules are evaluated inside the browser

The one design decision everything else hangs on. The desktop does not receive URLs and match them; the browser receives rules and matches locally:

1. Rules are stored as `project_path_mappings` rows with `kind = 'url_rule'`: a scheme-less, case-insensitive-host pattern over host + path with a single trailing glob (`github.com/acme/*`, `app.linear.app/acme/*`, `*.figma.com/files/*`). Same 500-char bound, same per-user uniqueness, same membership check as path prefixes. **The user never sees or types this syntax.** Rules are created by answering suggestions (point 4); the app generates the pattern — whole-site (eTLD+1) by default, path-narrowed only on hosts known to span projects (github.com, gitlab.com, linear.app and kin), where the suggestion asks the narrower question ("Is github.com/acme work?"). A raw pattern editor exists behind the Advanced disclosure for engineers.
2. The desktop writes the rule set (rule id + pattern only) to a rules file beside the spools. The extension fetches it through the host on connect and every five minutes. Longest-pattern-wins at match time; creating a duplicate pattern is rejected exactly as duplicate path prefixes are.
3. The extension emits events only for rule *hits*: `{ source: "browser", event, externalSessionId, ruleId, occurredAt }`. The URL that matched never leaves the browser. A tab that matches nothing produces nothing — unmatched browsing stays exactly as invisible as it is today.
4. Unmatched-origin suggestions are a local-only tally: the extension keeps focus-time per unmatched eTLD+1 in extension storage, and the desktop reads it through the host on demand. It surfaces as a plain question, one origin at a time: "You spent 3 hours on quickbooks.com this week. Is that work? **[Yes, for ⟨project⟩ ▾] [No — don't ask again]**". Yes creates the rule; No records a local never-suggest entry. Neither the tally nor the never-suggest list is ever uploaded, and both are user-clearable. This question-and-answer loop *is* the configuration surface — there is no rules screen to fill in, only questions the app earns the right to ask by observing focus time.

If the rules file is unreadable or stale, the extension matches nothing — the failure mode is silence, not leakage.

### Span lifecycle and debounce

A span opens when a matched rule's tab has held focus — browser window focused, machine not idle per `idle.onStateChanged` — for **15 seconds**; gaps shorter than 15 seconds (tab flips, quick look-aways) merge into the surrounding span rather than fragmenting it. The extension generates the span id, emits `started`, heartbeats every **60 seconds**, and emits `ended` on tab switch, window blur, idle, lock, or browser shutdown. A heavy tab-switcher produces dozens of rows a day, not hundreds — transitions, not ticks, same principle as activity segments.

### Contract reuse: browser spans are agent sessions

Browser spans upload as agent-session events with a new `source: "browser"` — the same batch endpoint, upsert key `(organizationId, userId, source, externalSessionId)`, out-of-order tolerance, freshness bound, and timer linking. The event contract gains an optional `ruleId`; `cwd` becomes conditionally required (exactly one of `cwd`/`ruleId`, by source). On ingest the API resolves `ruleId` against the caller's `url_rule` mappings: a live rule attributes the span to its project; a deleted or foreign rule leaves the span unattributed rather than erroring. Attribution is therefore still server-authoritative — the extension proposes, the stored mapping row decides.

Two deliberate divergences from agent-source behavior:

- **Staleness.** Browser spans reap at **10 minutes** of silence (heartbeats are every 60 seconds), not 6 hours. The reaper window becomes per-source.
- **The agent-active override does not apply.** An open agent session legitimately suppresses away auto-stop — an overnight agent run is unattended work. An open browser span means a tab is focused, which says nothing once the human leaves; browser spans never suppress idle trimming or auto-stop.

### Attribution boundaries

Browser spans do not add session duration. Machine-active segments already establish active time; the browser span's job is to say **which project** the active time belongs to. Concretely: linking to a running timer, attribution-mismatch surfacing, and suggested start all treat browser spans like agent sessions, but session-duration math is untouched. This keeps the semantics honest — a focused tab on an idle machine attributes nothing and adds no time — and means the reporting contract does not change shape.

`GET /me/stats` gains a `sites` array beside `apps`: per-rule focus totals, computed from browser spans clipped to the caller's `active` segments. The label shown is the rule pattern — text the user wrote — so the stats view introduces no new data class.

### Suggested start

A browser span opening on a mapped rule while no timer runs raises the existing tray prompt with the project preselected — but only after the span survives **60 seconds**, so glancing at GitHub does not prompt. One click starts an attributed timer; dismissal is remembered for the rest of that span. Same hybrid posture as agent sessions: automation proposes, the human confirms.

Prompt copy across the product is held to the grandmother test: a question, a highlighted default, no jargon. "Working on ⟨project⟩? **[Start timer]** [Not now]"; the Phase 2 away prompt likewise reads "You were away 23 minutes. Count that time? [No] **[Yes]**". With suggestions answering "what is work", prompts answering "when did it start", and the away flow answering "when did it stop", the steady-state use of the product is pressing large labeled buttons — the timer can be run indefinitely without ever opening settings.

## Alternatives considered

1. **UI Automation address-bar reading** (how much commercial tracking software works) was rejected: it captures full URLs for every site rather than verdicts for mapped ones, breaks across browser updates, costs a cross-process query per poll, and the browser fights it. The extension is the only route where the browser cooperates.
2. **Window titles** (org-gated in Phase 2's posture) were rejected for attribution: titles leak document names and email subjects, and are format-unstable across sites — worse signal, worse privacy.
3. **Shipping URLs to the desktop and matching there** was rejected even though it is simpler: it moves the entire browsing stream across a process boundary to answer a question the extension can answer in place. Verdict-only crossing is the difference between "tracks my work sites" and "reads my history", and Chrome's permission warning will already say the latter — the architecture should make the honest answer "but only rule verdicts ever leave".
4. **A localhost port instead of native messaging** was rejected for the same reason as in Phase 2: an open port is attack surface and fails silently; native messaging is browser-launched, extension-pinned, and lifecycle-managed.
5. **A new evidence stream and tables for browser spans** was rejected: the agent-session model (upsert, reaping, linking, freshness) fits exactly, and one additional source value plus a per-source reaper window is cheaper than a parallel pipeline.
6. **Adding duration from browser spans** was rejected: it would double-count what active segments already prove and would make a focused-but-abandoned tab look like verified work.

## Package architecture

- `packages/shared`: add `"browser"` to the runtime roster in `agent-runtimes.json`; `agentSessionEventSchema` gains optional `ruleId` with a source-conditional refinement; mapping schemas gain `kind: "path_prefix" | "url_rule"` and URL-rule pattern validation; `meStatsResponseSchema` gains `sites`.
- `packages/database`: `agent_sessions.source` is text with a shape check rather than a pg enum, so `'browser'` is accepted without a migration; `project_path_mappings` gains `kind` (default `path_prefix`, reusing the existing `pathPrefix` column and uniqueness for patterns); no new tables.
- `apps/api`: attribution service resolves `ruleId` for browser-source events; per-source reaper windows; `sites` aggregation in the report repository clipped to active segments; contract validation for the new shapes.
- `apps/desktop`: the four monitor fixes; `clock-in-browser-host` as a third bin target over the shared `spool` module plus a small stdio-framing module; rules-file writer; silent per-browser host registration at first run with health badges and one-click **[Fix]** repair; the first-run onboarding flow (sign in → one toggle → browser cards); suggestion-driven rule creation with pattern generation (eTLD+1 default, path-narrowing host list); the Tauri updater; the Advanced disclosure gating thresholds, path prefixes, raw patterns, and agent hooks (hooks shown only when a CLI is detected).
- `apps/browser-extension` (new workspace package): MV3 service worker in TypeScript, built with Vite; pure modules for rule matching, debounce/coalescing, and span lifecycle; thin adapters over `chrome.*` APIs. One build for Chrome/Edge, a manifest variant for Firefox.
- `.github/workflows/release.yml`: signing secrets for Windows and macOS wired into `tauri-action`, and updater artifacts published beside the installers.

## Data and request flow

Rules flow outward: desktop settings → `project_path_mappings` (server) → rules file (desktop) → host → extension. Verdicts flow inward: extension → host → browser spool → desktop drain → agent-session batch upload → upsert, `ruleId` resolution, timer linking. The desktop raises suggested-start locally from the drain, as it does for agent events. Reports and `/me/stats` read stored rows; browser spans contribute linking, mismatch review, and `sites` totals, never session duration.

## Security and privacy

- Full URLs, titles, and history never cross the extension boundary; only rule ids and timestamps do. Unmatched origins exist only in extension storage and the desktop's local needs-mapping view, are never uploaded, and are user-clearable.
- The extension requires the `tabs` permission, which Chrome surfaces as "read your browsing history". That warning is accurate about capability and wrong about behavior; the extension is open source in this repository, and the store listing and the desktop's "what's recorded" panel state exactly what leaves the browser.
- `clock-in-browser-host` holds no credentials and opens no sockets; the browser launches it with the extension pinned via `allowed_origins`; registration is per-user (HKCU), no elevation. It enforces message-size caps and ignores unknown message types. It must be code-signed with the desktop's certificate, like `clock-in-hook`.
- Incognito and guest windows are excluded unless the user flips the browser's own per-extension incognito toggle; Clock-In never asks for it.
- Rule patterns can contain org and project names; they are redacted from logs like `cwd` and shown only to the owning user and org admins.
- The whole signal is gated behind the same org-level policy switch as monitoring, off until enabled, and pausing monitoring also stops browser-span upload.
- The desktop now writes the browsers' own force-install policy (`ExtensionInstallForcelist`, HKCU) itself, by default, with an opt-out toggle; see the README privacy section. Firefox has no such path until an AMO listing exists.

## Error handling

Extension-side reconnect, durable identity isolation, and backpressure are defined by the [extension guide](../../apps/browser-extension/README.md). Host-side: malformed frames are dropped without killing the port; spool discipline is Phase 2's (locked whole-line appends, quarantine on parse failure, ack-before-truncate drain). Desktop-side: a missing or stale rules file fails closed to no matching; launch health checks distinguish "registry entry present, binary missing" from "never registered" but repair both silently where possible, and where not, badge the browser card with one sentence and **[Fix]**. Server-side: an event whose `ruleId` no longer resolves lands unattributed, not rejected; deleting a rule must not invalidate honest evidence already in flight.

## Testing and verification

Extension logic ships as pure functions — rule matching (longest-wins, case-insensitive host, glob bounds), the debounce/coalesce state machine, span lifecycle over injected clock and event streams — tested in Vitest with no browser. Pattern generation is pure and tested the same way: origin in, rule out, including the path-narrowing hosts. Host tests cover stdio framing, rules serving, and locked spool appends under concurrent writers. Monitor tests cover segment-close-on-foreground-change, UWP PID resolution shape, clock-gap synthesis (joint jump → `Suspended`, wall-only jump → split + flag), and disconnect mapping, all with injected sources. API tests cover the source-conditional event contract, `ruleId` resolution including deleted-rule fallback, per-source reaping, override exclusion, `sites` clipping, and that session-duration math is byte-for-byte unchanged for non-browser evidence. React tests cover the onboarding flow, browser cards flipping on handshake, the suggestion question creating a rule and the never-suggest path, and **[Fix]** performing its repair.

The manual checklist adds: register in Chrome and Edge, answer a suggestion, verify glance-vs-dwell (14s no span, 20s span), tab-flip merging, idle ends the span, suggested start at 60s, incognito silence, the needs-mapping tally staying local (network inspector shows no origin upload) — and a **usability pass run as the test's namesake**: someone non-technical performs setup from the dashboard download with no coaching, and every place they stall or ask a question is a bug against this design, not against them.

## Known gaps and open questions

- **Firefox** needs its own signed build and native-messaging manifest path; ship Chrome/Edge first, Firefox when demand exists. Safari waits for macOS support entirely.
- **Store distribution**: Chrome on Windows stable does not sideload, so the extension ships via the Web Store (unlisted) and Edge Add-ons; review latency becomes part of the release cadence.
- **Silent install**: Chrome/Edge force-install via the HKCU `ExtensionInstallForcelist` policy now removes the store clicks for everyone by default, with an opt-out toggle; Firefox still needs its AMO listing and keeps the manual flow.
- **Signing logistics**: an OV/EV certificate and Apple Developer enrollment have lead time and identity-verification steps; they gate distribution to non-engineers, so they start before implementation does.
- **Multi-profile browsers**: registration is per-user but extension install is per-profile; an unregistered profile is invisible, and the health badge cannot see profiles. Accepted; the monitor still records the browser as active.
- **Path-bearing SPAs** that rewrite URLs without navigation events are covered by `tabs.onUpdated`, but sites that keep state out of the URL entirely (some editors) can only be matched at origin granularity.
- **Watching a mapped site's video** with hands off the keyboard is attributed browser time on an idle machine: attributed but excluded from session duration, and correctly so. The false-idle rescue signals (mic-in-use, presentation mode, media session) remain a later phase, as does input-density sampling.
- **Rule quality is user labor**: attribution is only as good as the rules, same as path mappings. The needs-mapping tally is the mitigation.

## Deliberate limitations

- Verdict-only reporting is a ceiling as well as a floor: the server can never retroactively ask "what site was that really?" — the evidence does not exist off the machine, by construction.
- Browser spans attribute; they never add duration and never suppress idle handling.
- One running timer per user is unchanged; concurrent mapped tabs in different projects surface as review flags, not split timers.
- A determined user can fabricate spool lines here as everywhere; Phase 3 keeps raising the visibility of padding, not attempting proof.
