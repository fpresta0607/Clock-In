//! MV3 service worker: thin adapters from chrome.* events into the pure span
//! machine, and the native-messaging channel to `clock-in-browser-host`.
//!
//! Privacy posture, enforced here: rules arrive from the host and matching
//! happens in this process; only verdict events (`ruleId`, span id,
//! timestamps) ever leave. URLs, titles, and history are read for local
//! matching and the local unmatched-origin tally, and are never transmitted.
//! Unmatched tabs produce nothing; incognito and guest windows are excluded.

import { match, type UrlRule } from "./matching.js";
import {
  Outbox,
  OUTBOX_STORAGE_KEY,
  reconnectBackoffMs,
} from "./outbox.js";
import {
  advance,
  createSpanMachine,
  handleInput,
  type IdleState,
  type SpanEvent,
  type SpanInput,
  type SpanMachine,
} from "./spans.js";
import {
  addFocusSeconds,
  emptyTally,
  originFor,
  TALLY_STORAGE_KEY,
  tallySnapshot,
  type Tally,
} from "./tally.js";

/** The registered native-messaging host name (the desktop registers it). */
const HOST_NAME = "com.clock_in.browser_host";
const RULES_REFRESH_MS = 5 * 60 * 1000;
const TICK_MS = 5_000;
const TALLY_FLUSH_MS = 60_000;
const IDLE_DETECTION_SECONDS = 15;

let rules: UrlRule[] = [];
let port: chrome.runtime.Port | null = null;
let reconnectAttempt = 0;

const machine: SpanMachine = createSpanMachine();
const outbox = new Outbox<SpanEvent>();
let tally: Tally = emptyTally();

// The active tab's local verdict. `unmatchedOrigin` exists only to feed the
// local tally; it is never part of an emitted event.
let currentTabId: number | null = null;
let unmatchedOrigin: string | null = null;
let lastTickAt = Date.now();
let lastTallyFlushAt = 0;

function persistState(): void {
  void chrome.storage.local.set({
    [TALLY_STORAGE_KEY]: tally.entries,
    [OUTBOX_STORAGE_KEY]: outbox.snapshot(),
  });
}

function sendToHost(message: unknown): boolean {
  if (port === null) {
    return false;
  }
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function emitSpanEvents(events: readonly SpanEvent[]): void {
  for (const event of events) {
    if (!sendToHost({ type: "span-event", event })) {
      outbox.push(event);
    }
  }
  if (events.length > 0) {
    persistState();
  }
}

function feedMachine(input: SpanInput): void {
  emitSpanEvents(handleInput(machine, input, Date.now()));
}

function requestRules(): void {
  sendToHost({ type: "get-rules" });
}

function sendTally(): void {
  sendToHost({ type: "tally", entries: tallySnapshot(tally) });
}

function flushOutbox(): void {
  const queued = outbox.drain();
  for (const event of queued) {
    if (!sendToHost({ type: "span-event", event })) {
      outbox.push(event);
    }
  }
  persistState();
}

function isRule(value: unknown): value is UrlRule {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate["id"] === "string" && typeof candidate["pattern"] === "string";
}

function connect(): void {
  let opened: chrome.runtime.Port;
  try {
    opened = chrome.runtime.connectNative(HOST_NAME);
  } catch {
    scheduleReconnect();
    return;
  }
  port = opened;
  opened.onMessage.addListener((message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      (message as Record<string, unknown>)["type"] === "rules"
    ) {
      const list = (message as Record<string, unknown>)["rules"];
      // Fail closed: an unusable rule set matches nothing.
      rules = Array.isArray(list) ? list.filter(isRule) : [];
      reconnectAttempt = 0;
    }
  });
  opened.onDisconnect.addListener(() => {
    if (port === opened) {
      port = null;
    }
    scheduleReconnect();
  });
  requestRules();
  flushOutbox();
  sendTally();
}

function scheduleReconnect(): void {
  const delay = reconnectBackoffMs(reconnectAttempt);
  reconnectAttempt += 1;
  setTimeout(connect, delay);
}

/** The local verdict for a tab: rule hit, or the origin for the local tally. */
function applyTab(tab: chrome.tabs.Tab): void {
  currentTabId = tab.id ?? null;
  unmatchedOrigin = null;
  let ruleId: string | null = null;
  const url = tab.url ?? tab.pendingUrl;
  if (!tab.incognito && url !== undefined && url.length > 0) {
    ruleId = match(url, rules);
    unmatchedOrigin = ruleId === null ? originFor(url) : null;
  }
  feedMachine({ type: "active-tab", ruleId });
}

function watchActiveTab(windowId: number): void {
  const query: chrome.tabs.QueryInfo =
    windowId === chrome.windows.WINDOW_ID_CURRENT
      ? { active: true, lastFocusedWindow: true }
      : { active: true, windowId };
  void chrome.tabs.query(query).then((tabs) => {
    const tab = tabs[0];
    if (tab !== undefined) {
      applyTab(tab);
    }
  });
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  void chrome.tabs
    .get(activeInfo.tabId)
    .then(applyTab)
    .catch(() => {
      // The tab vanished between the event and the lookup; treat as no match.
      feedMachine({ type: "active-tab", ruleId: null });
    });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only URL changes in the active tab re-seat the state machine.
  if (tabId === currentTabId && changeInfo.url !== undefined) {
    applyTab(tab);
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  const focused = windowId !== chrome.windows.WINDOW_ID_NONE;
  feedMachine({ type: "window-focus", focused });
  if (focused) {
    watchActiveTab(windowId);
  }
});

chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS);
chrome.idle.onStateChanged.addListener((state) => {
  feedMachine({ type: "idle", state: state as IdleState });
});

// Chrome-only; Firefox event pages never fire it, so guard the lookup.
chrome.runtime.onSuspend?.addListener(() => {
  feedMachine({ type: "shutdown" });
});

// Steady tick: time-driven span transitions, heartbeat cadence, tally
// accumulation, and periodic local persistence.
setInterval(() => {
  const now = Date.now();
  emitSpanEvents(advance(machine, now));
  const elapsedSeconds = Math.max(0, Math.round((now - lastTickAt) / 1000));
  lastTickAt = now;
  if (unmatchedOrigin !== null && machine.windowFocused && machine.idleState === "active") {
    addFocusSeconds(tally, unmatchedOrigin, elapsedSeconds);
    if (now - lastTallyFlushAt >= TALLY_FLUSH_MS) {
      lastTallyFlushAt = now;
      persistState();
      sendTally();
    }
  }
}, TICK_MS);

// Rule refresh on the design's five-minute cadence.
setInterval(requestRules, RULES_REFRESH_MS);

// Startup: restore the local tally and any queued verdicts, then connect.
void chrome.storage.local
  .get([TALLY_STORAGE_KEY, OUTBOX_STORAGE_KEY])
  .then((stored) => {
    const entries = stored[TALLY_STORAGE_KEY];
    if (typeof entries === "object" && entries !== null) {
      tally = { entries: entries as Record<string, number> };
    }
    const queued = stored[OUTBOX_STORAGE_KEY];
    if (Array.isArray(queued)) {
      for (const event of queued as SpanEvent[]) {
        outbox.push(event);
      }
    }
    watchActiveTab(chrome.windows.WINDOW_ID_CURRENT);
    connect();
  });
