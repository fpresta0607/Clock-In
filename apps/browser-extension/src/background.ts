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
import { Outbox, OUTBOX_STORAGE_KEY } from "./outbox.js";
import {
  MIN_ALARM_MINUTES,
  reconnectDelayMinutes,
  RECONNECT_ALARM_NAME,
  RULES_REFRESH_ALARM_NAME,
  RULES_REFRESH_PERIOD_MINUTES,
  SPAN_ADVANCE_ALARM_NAME,
  TICK_ALARM_NAME,
  TICK_ALARM_PERIOD_MINUTES,
} from "./schedule.js";
import {
  advance,
  createSpanMachine,
  handleInput,
  nextAdvanceAt,
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
import { LAST_TICK_STORAGE_KEY, MACHINE_STORAGE_KEY, parseStartupStorage } from "./startup.js";

/** The registered native-messaging host name (the desktop registers it). */
const HOST_NAME = "com.clock_in.browser_host";
const TICK_MS = TICK_ALARM_PERIOD_MINUTES * 60_000;
const TALLY_FLUSH_MS = 60_000;
const IDLE_DETECTION_SECONDS = 15;

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
  const savedAt = Date.now();
  void chrome.storage.local.set({
    [TALLY_STORAGE_KEY]: tally.entries,
    [OUTBOX_STORAGE_KEY]: outbox.snapshot(),
    [MACHINE_STORAGE_KEY]: snapshotMachine(machine, savedAt),
    [LAST_TICK_STORAGE_KEY]: lastTickAt,
  }).catch(() => {
    // A later alarm or browser event retries. The in-memory state remains
    // authoritative for this worker lifetime.
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

function scheduleMachineAdvance(): void {
  const deadline = nextAdvanceAt(machine);
  if (deadline === null) {
    void chrome.alarms.clear(SPAN_ADVANCE_ALARM_NAME);
    return;
  }
  chrome.alarms.create(SPAN_ADVANCE_ALARM_NAME, {
    when: Math.max(Date.now() + 1, deadline),
  });
}

function advanceMachine(now: number): void {
  emitSpanEvents(advance(machine, now));
  scheduleMachineAdvance();
}

function feedMachine(input: SpanInput): void {
  const now = Date.now();
  // Expire stale merge windows before a newly observed tab can resume them.
  emitSpanEvents([...advance(machine, now), ...handleInput(machine, input, now)]);
  // Subject changes (candidate starts, suspensions) emit no events but must
  // still survive an eviction.
  persistState();
  scheduleMachineAdvance();
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
  if (port !== null) {
    return;
  }
  let opened: chrome.runtime.Port;
  try {
    opened = chrome.runtime.connectNative(HOST_NAME);
  } catch {
    scheduleReconnect();
    return;
  }
  port = opened;
  void chrome.alarms.clear(RECONNECT_ALARM_NAME);
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
  const delayInMinutes = reconnectDelayMinutes(reconnectAttempt);
  reconnectAttempt += 1;
  chrome.alarms.create(RECONNECT_ALARM_NAME, { delayInMinutes });
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
  void chrome.idle.queryState(IDLE_DETECTION_SECONDS)
    .then((state) => {
      feedMachine({ type: "idle", state: state as IdleState });
    })
    .catch(() => {
      // Keep the restored state suspended; expiry closes it at savedAt.
    });
  void chrome.windows.getLastFocused()
    .then((win) => {
      const focused = win.focused === true && win.id !== undefined;
      focusedWindowId = focused ? (win.id ?? null) : null;
      feedMachine({ type: "window-focus", focused });
      if (focused && win.id !== undefined) {
        watchActiveTab(win.id);
      }
    })
    .catch(() => {
      focusedWindowId = null;
      feedMachine({ type: "window-focus", focused: false });
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

// Alarm-driven tick: unlike an in-memory interval, this survives routine MV3
// worker eviction. The wall-clock delta is clamped and gaps trigger
// re-validation, so laptop sleep cannot credit hours to a stale origin.
function runTick(): void {
  const now = Date.now();
  const { creditMs, gapExceeded } = tickCredit(now, lastTickAt, TICK_MS);
  lastTickAt = now;
  if (gapExceeded) {
    revalidateAttention();
  }
  advanceMachine(now);
  if (unmatchedOrigin !== null && machine.windowFocused && machine.idleState === "active") {
    addFocusSeconds(tally, unmatchedOrigin, Math.round(creditMs / 1000));
  }
  if (now - lastTallyFlushAt >= TALLY_FLUSH_MS) {
    lastTallyFlushAt = now;
    persistState();
    sendTally();
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  switch (alarm.name) {
    case TICK_ALARM_NAME:
      runTick();
      break;
    case RULES_REFRESH_ALARM_NAME:
      requestRules();
      break;
    case RECONNECT_ALARM_NAME:
      connect();
      break;
    case SPAN_ADVANCE_ALARM_NAME:
      advanceMachine(Date.now());
      break;
  }
});

function ensurePeriodicAlarm(name: string, periodInMinutes: number): void {
  void chrome.alarms.get(name).then((existing) => {
    if (existing === undefined) {
      chrome.alarms.create(name, {
        delayInMinutes: Math.max(MIN_ALARM_MINUTES, periodInMinutes),
        periodInMinutes,
      });
    }
  });
}

ensurePeriodicAlarm(TICK_ALARM_NAME, TICK_ALARM_PERIOD_MINUTES);
ensurePeriodicAlarm(RULES_REFRESH_ALARM_NAME, RULES_REFRESH_PERIOD_MINUTES);

// Startup: restore the local tally, queued verdicts, and the span machine;
// re-derive attention from the platform; then connect.
void chrome.storage.local
  .get([TALLY_STORAGE_KEY, OUTBOX_STORAGE_KEY, MACHINE_STORAGE_KEY, LAST_TICK_STORAGE_KEY])
  .catch(() => undefined)
  .then((stored) => {
    const startup = parseStartupStorage(stored);
    tally = { entries: startup.tallyEntries };
    for (const event of startup.queuedEvents) {
      outbox.push(event);
    }
    const now = Date.now();
    // A persisted tick keeps local focus totals honest across routine worker
    // eviction. Future values from a wall-clock change fail toward zero.
    lastTickAt = Math.min(now, startup.lastTickAt ?? now);
    const restored = restoreMachine(startup.machineSnapshot, now);
    machine = restored.machine;
    emitSpanEvents(restored.emitted);
    scheduleMachineAdvance();
    revalidateAttention();
    connect();
  });
