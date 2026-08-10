# @clock-in/browser-extension

The Clock-In browser extension (Manifest V3): it matches the active tab against the user's URL rules locally and reports only the verdict to the desktop app.
Chrome and Edge ship from one build; Firefox ships as a thin manifest variant.

## What leaves the browser

Only this: "rule N matched from 14:02 to 14:31".
Span events carry `ruleId`, a generated span id, and timestamps - nothing else.
Full URLs, page titles, and browsing history are read inside this process for local matching and are never transmitted.
A tab that matches no rule produces nothing at all.

Three things never leave the machine at all:

- The unmatched-origin tally (focus seconds per unmatched eTLD+1) lives in extension storage and is mirrored to the desktop's local needs-mapping view through the native host.
  It is never uploaded, and it is user-clearable.
- The queued-verdict outbox holds up to 1,000 saved verdicts in extension storage until the native host is reachable again. At capacity, capture pauses until saved activity syncs; no saved verdict is dropped.
- The span machine's in-flight state (open span, dwell candidate, session id) sits in extension storage so an MV3 service-worker eviction cannot strand an open span. A corrupt or unavailable read starts fresh; after an unobserved gap, the restored span closes at the last provable attention time before the extension rechecks browser focus and idle state.

Off-the-record tabs are excluded via `tab.incognito` (Chrome's Guest windows report as off-the-record); Clock-In never asks for the browser's incognito toggle.

## Permissions and why

- `tabs` - to read the active tab's URL for local rule matching.
  Chrome surfaces this as "read your browsing history"; the capability is real, the behavior is verdict-only, and the code is auditable in this repository.
- `idle` - to end spans when the machine goes idle or locks (`idle.onStateChanged`).
- `storage` - to persist the local tally and the offline outbox across service-worker restarts.
- `nativeMessaging` - to talk to `clock-in-browser-host`, the desktop's local stdio bridge, which holds no credentials and opens no sockets.
- `alarms` - to schedule ticks, rule refreshes, reconnects, and pending span transitions after an MV3 service-worker eviction.

## Wire protocol

The extension speaks Chrome native messaging to the host registered as `com.clock_in.browser_host` after the desktop is built with that browser's released extension ID.
Framing (4-byte little-endian length-prefixed JSON) is handled by `chrome.runtime.connectNative`; the JSON shapes are:

- `{"type":"get-rules"}` -> `{"type":"rules","collectionEnabled","collectionId","rules":[{"id","pattern"}]}`; fetched on connect and every five minutes.
  An empty rule set matches nothing (fail closed).
- `{"type":"span-event","collectionId","event":{"event","externalSessionId","ruleId","occurredAt"}}` - appended to the desktop's local browser spool. A `span-ack` returns the acknowledged event; `span-retry` keeps it queued, and `collection-state` means collection is unavailable.
- `{"type":"tally","collectionId","weekStart","entries":[{"origin","seconds"}]}` - a snapshot of the local unmatched-origin tally; read-only passthrough, never uploaded. The host returns `collection-state` and may send `clear-tally` before it.

When the host is unreachable, span events queue in a 1,000-entry persisted outbox and replay on reconnect (30 s backoff doubling to 60 s). At capacity, capture pauses and resumes only after the saved activity has synced and the user resumes tracking.

## Layout

- `src/matching.ts` - longest-pattern-wins rule matching (pure).
- `src/spans.ts` - the span state machine over an injected clock: 15 s dwell to open, sub-15 s gaps merge, 60 s heartbeats, `ended` on tab switch / blur / idle / lock / shutdown (pure).
- `src/tally.ts` - the local unmatched eTLD+1 focus-time tally (pure).
- `src/outbox.ts` - the bounded offline outbox and reconnect backoff (pure).
- `src/background.ts` - the MV3 service worker: chrome.* adapters, durable alarms, and conservative startup recovery around the state machine.
- `src/schedule.ts` / `src/startup.ts` - persistent MV3 cadence and validation at the extension-storage boundary.
- `manifest.chrome.json` / `manifest.firefox.json` - build variants.

## Build

`pnpm build` runs Vite (single-file `background.js`) and `scripts/package.mjs`, which writes `dist-chrome/`, `dist-firefox/`, and store-ready zips under `release/`.
