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
  addFocusMilliseconds,
  clearTally,
  emptyTally,
  originFor,
  rollTallyIntoCurrentWeek,
  TALLY_STORAGE_KEY,
  tallySnapshot,
  type Tally,
} from "./tally.js";
import { tickCredit } from "./tick.js";
import {
  COLLECTION_ID_STORAGE_KEY,
  LAST_TICK_STORAGE_KEY,
  MACHINE_STORAGE_KEY,
  parseStartupStorage,
} from "./startup.js";

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
let collectionEnabled = false;
let collectionId: string | undefined;

// The active tab's local verdict. `unmatchedOrigin` exists only to feed the
// local tally; it is never part of an emitted event.
let currentTabId: number | null = null;
let unmatchedOrigin: string | null = null;
// The window holding OS focus, per windows.onFocusChanged; null while no
// Chrome window is focused. Tab activations outside this window are ignored.
let focusedWindowId: number | null = null;
let tabReadGeneration = 0;
let lastTickAt = Date.now();
let lastTallyFlushAt = 0;

function persistState(): void {
  const savedAt = Date.now();
  void chrome.storage.local.set({
    [TALLY_STORAGE_KEY]: tally,
    [OUTBOX_STORAGE_KEY]: outbox.snapshot(),
    [MACHINE_STORAGE_KEY]: snapshotMachine(machine, savedAt),
    [LAST_TICK_STORAGE_KEY]: lastTickAt,
    [COLLECTION_ID_STORAGE_KEY]: collectionId ?? null,
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
  if (collectionId === undefined) {
    return;
  }
  for (const event of events) {
    if (!sendToHost({ type: "span-event", event, collectionId })) {
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

function resetLocalCollectionState(now: number = Date.now()): void {
  machine = createSpanMachine();
  currentTabId = null;
  unmatchedOrigin = null;
  focusedWindowId = null;
  tabReadGeneration += 1;
  lastTickAt = now;
  lastTallyFlushAt = 0;
}

function settleTally(now: number): void {
  const { creditMs } = tickCredit(now, lastTickAt, TICK_MS);
  if (collectionEnabled && unmatchedOrigin !== null && machine.windowFocused && machine.idleState === "active") {
    addFocusMilliseconds(tally, unmatchedOrigin, creditMs, now);
  }
  lastTickAt = now;
}

function fenceUnobservedGap(now: number): boolean {
  if (!tickCredit(now, lastTickAt, TICK_MS).gapExceeded) {
    return false;
  }
  const lastProvableAt = Math.min(lastTickAt, now);
  lastTickAt = now;
  currentTabId = null;
  unmatchedOrigin = null;
  tabReadGeneration += 1;
  emitSpanEvents([
    ...handleInput(machine, { type: "window-focus", focused: false }, lastProvableAt),
    ...advance(machine, now),
  ]);
  persistState();
  scheduleMachineAdvance();
  revalidateAttention();
  return true;
}

function prepareMachineTransition(now: number): boolean {
  if (fenceUnobservedGap(now)) {
    return false;
  }
  settleTally(now);
  return true;
}

function advanceMachine(now: number): void {
  if (!prepareMachineTransition(now)) {
    return;
  }
  emitSpanEvents(advance(machine, now));
  scheduleMachineAdvance();
}

function feedMachine(input: SpanInput, now: number = Date.now(), settle: boolean = true): void {
  if (settle && !prepareMachineTransition(now)) {
    return;
  }
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
  if (!collectionEnabled || collectionId === undefined) {
    return;
  }
  sendToHost({
    type: "tally",
    collectionId,
    weekStart: tally.weekStart,
    entries: tallySnapshot(tally),
  });
}

function flushOutbox(): void {
  if (!collectionEnabled || collectionId === undefined) {
    return;
  }
  const queued = outbox.drain();
  for (const event of queued) {
    if (!sendToHost({ type: "span-event", event, collectionId })) {
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

function collectionDetails(message: Record<string, unknown>): { enabled: boolean; id: string | undefined } {
  const id = message["collectionId"];
  return {
    enabled: message["collectionEnabled"] === true && typeof id === "string" && id.length > 0,
    id: typeof id === "string" && id.length > 0 ? id : undefined,
  };
}

function applyCollectionState(message: Record<string, unknown>): boolean {
  const { enabled, id } = collectionDetails(message);
  if (!enabled || id === undefined) {
    const changed = collectionEnabled || collectionId !== undefined;
    collectionEnabled = false;
    collectionId = undefined;
    rules = [];
    resetLocalCollectionState();
    outbox.clear();
    clearTally(tally);
    persistState();
    return changed;
  }
  const changed = collectionId !== id;
  if (changed) {
    collectionEnabled = false;
    collectionId = undefined;
    rules = [];
    resetLocalCollectionState();
    outbox.clear();
    clearTally(tally);
  }
  collectionEnabled = true;
  collectionId = id;
  if (changed) {
    persistState();
  }
  return changed;
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
    if (typeof message !== "object" || message === null) {
      return;
    }
    const payload = message as Record<string, unknown>;
    if (payload["type"] === "clear-tally") {
      clearTally(tally);
      lastTickAt = Date.now();
      persistState();
      sendTally();
      return;
    }
    if (payload["type"] === "collection-state") {
      if (applyCollectionState(payload) && collectionEnabled) {
        requestRules();
      }
      return;
    }
    if (payload["type"] === "rules") {
      const collectionChanged = applyCollectionState(payload);
      const list = payload["rules"];
      // Fail closed: an unusable rule set matches nothing.
      rules = collectionEnabled && Array.isArray(list) ? list.filter(isRule) : [];
      reconnectAttempt = 0;
      // A new rule set changes the verdict of the tab already open.
      if (collectionChanged) {
        revalidateAttention();
      } else {
        reApplyActiveTab();
      }
      flushOutbox();
      sendTally();
    }
  });
  opened.onDisconnect.addListener(() => {
    if (port === opened) {
      port = null;
    }
    scheduleReconnect();
  });
  requestRules();
}

function scheduleReconnect(): void {
  const delayInMinutes = reconnectDelayMinutes(reconnectAttempt);
  reconnectAttempt += 1;
  chrome.alarms.create(RECONNECT_ALARM_NAME, { delayInMinutes });
}

/** The local verdict for a tab: rule hit, or the origin for the local tally. */
function applyTab(tab: chrome.tabs.Tab): void {
  const now = Date.now();
  if (!prepareMachineTransition(now)) {
    return;
  }
  currentTabId = tab.id ?? null;
  unmatchedOrigin = null;
  let ruleId: string | null = null;
  const url = tab.url ?? tab.pendingUrl;
  if (collectionEnabled && !tab.incognito && url !== undefined && url.length > 0) {
    ruleId = match(url, rules);
    unmatchedOrigin = ruleId === null ? originFor(url) : null;
  }
  feedMachine({ type: "active-tab", ruleId }, now, false);
}

function canApplyTabRead(tab: chrome.tabs.Tab, windowId: number, generation: number): boolean {
  return tabReadGeneration === generation &&
    focusedWindowId === windowId &&
    tab.windowId === windowId;
}

function watchActiveTab(windowId: number): void {
  const generation = tabReadGeneration + 1;
  tabReadGeneration = generation;
  const query: chrome.tabs.QueryInfo = { active: true, windowId };
  void chrome.tabs.query(query).then((tabs) => {
    const tab = tabs[0];
    if (tab !== undefined && canApplyTabRead(tab, windowId, generation)) {
      applyTab(tab);
    }
  });
}

/** Re-evaluates the tracked tab against the current rule set. */
function reApplyActiveTab(): void {
  if (currentTabId === null) {
    return;
  }
  const tabId = currentTabId;
  const windowId = focusedWindowId;
  if (windowId === null) {
    return;
  }
  const generation = tabReadGeneration + 1;
  tabReadGeneration = generation;
  void chrome.tabs
    .get(tabId)
    .then((tab) => {
      if (tab.id === tabId && canApplyTabRead(tab, windowId, generation)) {
        applyTab(tab);
      }
    })
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
  void initialized.then(() => {
    // A tab switch in a window the user is not looking at must not move the
    // state machine.
    if (!shouldApplyTabActivation(activeInfo.windowId, focusedWindowId)) {
      return;
    }
    const generation = tabReadGeneration + 1;
    tabReadGeneration = generation;
    void chrome.tabs
      .get(activeInfo.tabId)
      .then((tab) => {
        if (tab.id === activeInfo.tabId && canApplyTabRead(tab, activeInfo.windowId, generation)) {
          applyTab(tab);
        }
      })
      .catch(() => {
        // The tab vanished between the event and the lookup; treat as no match.
        if (tabReadGeneration === generation && focusedWindowId === activeInfo.windowId) {
          feedMachine({ type: "active-tab", ruleId: null });
        }
      });
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void initialized.then(() => {
    // Only URL changes in the active tab re-seat the state machine.
    if (tabId === currentTabId && changeInfo.url !== undefined && tab.windowId === focusedWindowId) {
      tabReadGeneration += 1;
      applyTab(tab);
    }
  });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  void initialized.then(() => {
    const focused = windowId !== chrome.windows.WINDOW_ID_NONE;
    tabReadGeneration += 1;
    focusedWindowId = focused ? windowId : null;
    feedMachine({ type: "window-focus", focused });
    if (focused) {
      watchActiveTab(windowId);
    }
  });
});

chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS);
chrome.idle.onStateChanged.addListener((state) => {
  void initialized.then(() => {
    feedMachine({ type: "idle", state: state as IdleState });
  });
});

// Alarm-driven tick: unlike an in-memory interval, this survives routine MV3
// worker eviction. The wall-clock delta is clamped and gaps trigger
// re-validation, so laptop sleep cannot credit hours to a stale origin.
function runTick(): void {
  const now = Date.now();
  if (rollTallyIntoCurrentWeek(tally, now)) {
    persistState();
  }
  if (!prepareMachineTransition(now)) {
    return;
  }
  emitSpanEvents(advance(machine, now));
  scheduleMachineAdvance();
  if (now - lastTallyFlushAt >= TALLY_FLUSH_MS) {
    lastTallyFlushAt = now;
    persistState();
    sendTally();
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  void initialized.then(() => {
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

async function initialize(): Promise<void> {
  const stored = await chrome.storage.local
    .get([TALLY_STORAGE_KEY, OUTBOX_STORAGE_KEY, MACHINE_STORAGE_KEY, LAST_TICK_STORAGE_KEY, COLLECTION_ID_STORAGE_KEY])
    .catch(() => undefined);
  const now = Date.now();
  const startup = parseStartupStorage(stored, now);
  tally = startup.tally;
  collectionId = startup.collectionId;
  for (const event of startup.queuedEvents) {
    outbox.push(event);
  }
  lastTickAt = Math.min(now, startup.lastTickAt ?? now);
  const restored = restoreMachine(startup.machineSnapshot, now);
  machine = restored.machine;
  emitSpanEvents(restored.emitted);
  scheduleMachineAdvance();
  revalidateAttention();
  connect();
}

const initialized = initialize();
