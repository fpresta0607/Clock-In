//! MV3 service worker: thin adapters from chrome.* events into the pure span
//! machine, and the native-messaging channel to `clock-in-browser-host`.
//!
//! Privacy posture, enforced here: rules arrive from the host and matching
//! happens in this process; only verdict events (`ruleId`, span id,
//! timestamps) ever leave. URLs, titles, and history are read for local
//! matching and the local unmatched-origin tally, and are never transmitted.
//! Unmatched tabs produce nothing. Off-the-record tabs are excluded via
//! `tab.incognito` (Chrome's Guest windows report as off-the-record too);
//! that flag is the entire exclusion mechanism, and Clock-In never asks for
//! the browser's per-extension incognito toggle.
//!
//! Durability: the span machine's subjects are persisted to extension
//! storage with the tally and outbox, so an MV3 eviction does not strand an
//! open span. Restore is conservative (see spans.ts); startup re-derives
//! attention from focus/idle/tab queries before anything else runs.

import { shouldApplyTabActivation } from "./activation.js";
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
  restoreMachine,
  snapshotMachine,
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
import { tickCredit } from "./tick.js";

/** The registered native-messaging host name (the desktop registers it). */
const HOST_NAME = "com.clock_in.browser_host";
const RULES_REFRESH_MS = 5 * 60 * 1000;
const TICK_MS = 5_000;
const TALLY_FLUSH_MS = 60_000;
const IDLE_DETECTION_SECONDS = 15;
const MACHINE_STORAGE_KEY = "spanMachine";

let rules: UrlRule[] = [];
let port: chrome.runtime.Port | null = null;
let reconnectAttempt = 0;

let machine: SpanMachine = createSpanMachine();
const outbox = new Outbox<SpanEvent>();
let tally: Tally = emptyTally();

// The active tab's local verdict. `unmatchedOrigin` exists only to feed the
// local tally; it is never part of an emitted event.
let currentTabId: number | null = null;
let unmatchedOrigin: string | null = null;
// The window holding OS focus, per windows.onFocusChanged; null while no
// Chrome window is focused. Tab activations outside this window are ignored.
let focusedWindowId: number | null = null;
let lastTickAt = Date.now();
let lastTallyFlushAt = 0;

function persistState(): void {
  void chrome.storage.local.set({
    [TALLY_STORAGE_KEY]: tally.entries,
    [OUTBOX_STORAGE_KEY]: outbox.snapshot(),
    [MACHINE_STORAGE_KEY]: snapshotMachine(machine),
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
  // Subject changes (candidate starts, suspensions) emit no events but must
  // still survive an eviction.
  persistState();
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
      // A new rule set changes the verdict of the tab already open.
      reApplyActiveTab();
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

/** Re-evaluates the tracked tab against the current rule set. */
function reApplyActiveTab(): void {
  if (currentTabId === null) {
    return;
  }
  void chrome.tabs
    .get(currentTabId)
    .then(applyTab)
    .catch(() => {
      // The tab vanished; the next activation re-seats the machine.
    });
}

/**
 * Re-derives attention from the platform after a gap (timer sleep, worker
 * restart): the remembered idle/focus state may be hours stale.
 */
function revalidateAttention(): void {
  void chrome.idle.queryState(IDLE_DETECTION_SECONDS).then((state) => {
    feedMachine({ type: "idle", state: state as IdleState });
  });
  void chrome.windows.getLastFocused().then((win) => {
    const focused = win.focused === true && win.id !== undefined;
    focusedWindowId = focused ? (win.id ?? null) : null;
    feedMachine({ type: "window-focus", focused });
    if (focused && win.id !== undefined) {
      watchActiveTab(win.id);
    }
  });
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  // A tab switch in a window the user is not looking at must not move the
  // state machine.
  if (!shouldApplyTabActivation(activeInfo.windowId, focusedWindowId)) {
    return;
  }
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
  focusedWindowId = focused ? windowId : null;
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
  persistState();
});

// Steady tick: time-driven span transitions, heartbeat cadence, tally
// accumulation, and periodic local persistence. The wall-clock delta is
// clamped and gaps trigger re-validation: a laptop sleep must not credit
// hours to a stale origin or trust stale focus/idle state.
setInterval(() => {
  const now = Date.now();
  const { creditMs, gapExceeded } = tickCredit(now, lastTickAt, TICK_MS);
  lastTickAt = now;
  if (gapExceeded) {
    revalidateAttention();
  }
  emitSpanEvents(advance(machine, now));
  if (unmatchedOrigin !== null && machine.windowFocused && machine.idleState === "active") {
    addFocusSeconds(tally, unmatchedOrigin, Math.round(creditMs / 1000));
  }
  if (now - lastTallyFlushAt >= TALLY_FLUSH_MS) {
    lastTallyFlushAt = now;
    persistState();
    sendTally();
  }
}, TICK_MS);

// Rule refresh on the design's five-minute cadence.
setInterval(requestRules, RULES_REFRESH_MS);

// Startup: restore the local tally, queued verdicts, and the span machine;
// re-derive attention from the platform; then connect.
void chrome.storage.local
  .get([TALLY_STORAGE_KEY, OUTBOX_STORAGE_KEY, MACHINE_STORAGE_KEY])
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
    machine = restoreMachine(stored[MACHINE_STORAGE_KEY], Date.now());
    revalidateAttention();
    connect();
  });
