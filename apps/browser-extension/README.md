# @clock-in/browser-extension

The Clock-In browser extension (Manifest V3): it matches the active tab against the user's URL rules locally and reports only the verdict to the desktop app.
Chrome and Edge ship from one build; Firefox ships as a thin manifest variant.

## What leaves the browser

Only this: "rule N matched from 14:02 to 14:31".
Span events carry `ruleId`, a generated span id, and timestamps - nothing else.
Full URLs, page titles, and browsing history are read inside this process for local matching and are never transmitted.
A tab that matches no rule produces nothing at all.

Two things never leave the machine at all:

- The unmatched-origin tally (focus seconds per unmatched eTLD+1) lives in extension storage and is mirrored to the desktop's local needs-mapping view through the native host.
  It is never uploaded, and it is user-clearable.
- The queued-verdict outbox (bounded ring, oldest dropped) sits in extension storage until the native host is reachable again.

Incognito and guest windows are excluded; Clock-In never asks for the browser's incognito toggle.

## Permissions and why

- `tabs` - to read the active tab's URL for local rule matching.
  Chrome surfaces this as "read your browsing history"; the capability is real, the behavior is verdict-only, and the code is auditable in this repository.
- `idle` - to end spans when the machine goes idle or locks (`idle.onStateChanged`).
- `storage` - to persist the local tally and the offline outbox across service-worker restarts.
- `nativeMessaging` - to talk to `clock-in-browser-host`, the desktop's local stdio bridge, which holds no credentials and opens no sockets.

## Wire protocol

The extension speaks Chrome native messaging to the host registered as `com.clock_in.browser_host` (the desktop registers it silently per browser).
Framing (4-byte little-endian length-prefixed JSON) is handled by `chrome.runtime.connectNative`; the JSON shapes are:

- `{"type":"get-rules"}` -> `{"type":"rules","rules":[{"id","pattern"}]}`; fetched on connect and every five minutes.
  An empty rule set matches nothing (fail closed).
- `{"type":"span-event","event":{"event","externalSessionId","ruleId","occurredAt"}}` - appended to the desktop's local browser spool; no reply.
- `{"type":"tally","entries":[{"origin","seconds"}]}` - a snapshot of the local unmatched-origin tally; read-only passthrough, never uploaded.

When the host is unreachable, span events queue in a 1000-entry ring in extension storage and replay on reconnect (1 s backoff doubling to 60 s).

## Layout

- `src/matching.ts` - longest-pattern-wins rule matching (pure).
- `src/spans.ts` - the span state machine over an injected clock: 15 s dwell to open, sub-15 s gaps merge, 60 s heartbeats, `ended` on tab switch / blur / idle / lock / shutdown (pure).
- `src/tally.ts` - the local unmatched eTLD+1 focus-time tally (pure).
- `src/outbox.ts` - the bounded offline ring and reconnect backoff (pure).
- `src/background.ts` - the MV3 service worker: chrome.* adapters feeding the state machine.
- `manifest.chrome.json` / `manifest.firefox.json` - build variants.

## Build

`pnpm build` runs Vite (single-file `background.js`) and `scripts/package.mjs`, which writes `dist-chrome/`, `dist-firefox/`, and store-ready zips under `release/`.
