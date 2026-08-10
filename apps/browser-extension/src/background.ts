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
  OUTBOX_NAMESPACE_RESERVATIONS_STORAGE_KEY,
  OUTBOX_NAMESPACES_STORAGE_KEY,
  OUTBOX_STORAGE_KEY,
  canActivateOutboxNamespace,
  pruneOutboxNamespaces,
} from "./outbox.js";
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
  weekStartAt,
} from "./tally.js";
import { tickCredit } from "./tick.js";
import {
  COLLECTION_ID_STORAGE_KEY,
  COLLECTION_NAMESPACE_STORAGE_KEY,
  CAPTURE_PAUSED_NAMESPACES_STORAGE_KEY,
  CAPTURE_PAUSED_STORAGE_KEY,
  LAST_TICK_STORAGE_KEY,
  MACHINE_STORAGE_KEY,
  isIdentityNamespace,
  isSpanEvent,
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
let outbox = new Outbox<SpanEvent>();
const outboxes = new Map<string, Outbox<SpanEvent>>();
const reservedOutboxNamespaces = new Set<string>();
const reservationPersistencePending = new Set<string>();
let tally: Tally = emptyTally();
let collectionEnabled = false;
let collectionId: string | undefined;
let collectionNamespace: string | undefined;
let capturePaused = false;
let captureResumePending = false;
let pauseAwaitingHostConfirmation = false;
let storageWriteFailed = false;
let pendingStorageWrites = 0;
let storageWriteTail: Promise<void> = Promise.resolve();
const capturePausedNamespaces = new Map<string, boolean>();
let eventCommitPending = false;
const deferredHostMessages: Record<string, unknown>[] = [];

// The active tab's local verdict. `unmatchedOrigin` exists only to feed the
// local tally; it is never part of an emitted event.
let currentTabId: number | null = null;
let unmatchedOrigin: string | null = null;
// The window holding OS focus, per windows.onFocusChanged; null while no
// Chrome window is focused. Tab activations outside this window are ignored.
let focusedWindowId: number | null = null;
let tabReadGeneration = 0;
let attentionGeneration = 0;
let attentionConfirmed = false;
const inFlightSpans = new Set<string>();
let lastTickAt = Date.now();
let lastTallyFlushAt = 0;

interface StagedSpanCommit {
  namespace: string;
  events: readonly SpanEvent[];
}

function queuedSnapshot(namespace: string, queued: Outbox<SpanEvent>, staged: StagedSpanCommit | undefined): SpanEvent[] {
  return namespace === staged?.namespace
    ? [...queued.snapshot(), ...staged.events]
    : queued.snapshot();
}

function commitStagedSpans(staged: StagedSpanCommit): boolean {
  const queued = outboxes.get(staged.namespace);
  if (queued === undefined) {
    return false;
  }
  for (const event of staged.events) {
    if (!queued.snapshot().some((candidate) => sameSpanEvent(candidate, event)) && !queued.push(event)) {
      return false;
    }
  }
  return true;
}

function persistState(staged: StagedSpanCommit | undefined = undefined): Promise<boolean> {
  pruneOutboxes();
  const savedAt = Date.now();
  const activeNamespace = collectionNamespace;
  const state = {
    [TALLY_STORAGE_KEY]: tally,
    [OUTBOX_STORAGE_KEY]: staged !== undefined && activeNamespace === staged.namespace
      ? [...outbox.snapshot(), ...staged.events]
      : outbox.snapshot(),
    [OUTBOX_NAMESPACES_STORAGE_KEY]: Object.fromEntries(
      [...outboxes.entries()].map(([namespace, queued]) => [namespace, queuedSnapshot(namespace, queued, staged)]),
    ),
    [OUTBOX_NAMESPACE_RESERVATIONS_STORAGE_KEY]: [...reservedOutboxNamespaces],
    [MACHINE_STORAGE_KEY]: snapshotMachine(machine, savedAt),
    [LAST_TICK_STORAGE_KEY]: lastTickAt,
    [COLLECTION_ID_STORAGE_KEY]: collectionId ?? null,
    [COLLECTION_NAMESPACE_STORAGE_KEY]: activeNamespace ?? null,
    [CAPTURE_PAUSED_STORAGE_KEY]: capturePaused,
    [CAPTURE_PAUSED_NAMESPACES_STORAGE_KEY]: Object.fromEntries(capturePausedNamespaces),
  };
  pendingStorageWrites += 1;
  const write = storageWriteTail.then(() => chrome.storage.local.set(state));
  storageWriteTail = write.then(
    () => undefined,
    () => undefined,
  );
  return write.then(() => {
    pendingStorageWrites -= 1;
    storageWriteFailed = false;
    if (staged !== undefined) {
      eventCommitPending = false;
      if (!commitStagedSpans(staged)) {
        pauseCapture();
        drainDeferredHostMessages();
        return false;
      }
      drainDeferredHostMessages();
      requestRules();
      revalidateAttention();
    }
    if (pendingStorageWrites === 0) {
      sendNamespaceCapacity();
      flushOutbox();
    }
    return true;
  }, () => {
    pendingStorageWrites -= 1;
    if (staged !== undefined) {
      eventCommitPending = false;
    }
    storageWriteFailed = true;
    pauseCapture();
    drainDeferredHostMessages();
    return false;
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

function sendNamespaceCapacity(): void {
  if (collectionId === undefined || !isIdentityNamespace(collectionNamespace)) {
    return;
  }
  sendToHost({
    type: "namespace-capacity",
    collectionId,
    namespaces: [...outboxes.entries()]
      .filter(([namespace]) => isIdentityNamespace(namespace))
      .map(([namespace, queued]) => ({ namespace, pending: queued.size })),
  });
}

function emitSpanEvents(events: readonly SpanEvent[]): boolean {
  if (events.length === 0) {
    return false;
  }
  const namespace = collectionNamespace;
  if (eventCommitPending) {
    return true;
  }
  if (collectionId === undefined || namespace === undefined || capturePaused || captureResumePending) {
    return false;
  }
  if (storageWriteFailed || events.length > outbox.remainingCapacity) {
    pauseCapture();
    return true;
  }
  eventCommitPending = true;
  void persistState({ namespace, events: [...events] });
  return true;
}

function pauseCapture(): void {
  if (capturePaused || collectionId === undefined || collectionNamespace === undefined) {
    return;
  }
  capturePaused = true;
  captureResumePending = false;
  pauseAwaitingHostConfirmation = true;
  capturePausedNamespaces.set(collectionNamespace, true);
  rules = [];
  resetLocalCollectionState();
  persistState();
  sendToHost({ type: "capture-paused", collectionId });
}

function applyCapturePause(message: Record<string, unknown>): void {
  if (collectionNamespace === undefined) {
    return;
  }
  const paused = message["capturePaused"] === true;
  if (paused) {
    if (!capturePaused) {
      pauseCapture();
    } else {
      pauseAwaitingHostConfirmation = false;
      if (storageWriteFailed) void persistState();
    }
    return;
  }
  if (!capturePaused || outbox.remainingCapacity === 0 || pauseAwaitingHostConfirmation || captureResumePending) {
    return;
  }
  if (storageWriteFailed) {
    void persistState();
    return;
  }
  capturePaused = false;
  capturePausedNamespaces.delete(collectionNamespace);
  captureResumePending = true;
  void persistState().then((persisted) => {
    if (!persisted || capturePaused) return;
    captureResumePending = false;
    requestRules();
    revalidateAttention();
  });
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
  attentionGeneration += 1;
  attentionConfirmed = false;
  inFlightSpans.clear();
  lastTickAt = now;
  lastTallyFlushAt = 0;
}

function settleTally(now: number): void {
  const { creditMs } = tickCredit(now, lastTickAt, TICK_MS);
  if (collectionEnabled && unmatchedOrigin !== null && machine.windowFocused && machine.idleState === "active") {
    const creditStartedAt = now - creditMs;
    const currentWeekStart = weekStartAt(now);
    if (creditStartedAt < currentWeekStart) {
      addFocusMilliseconds(tally, unmatchedOrigin, currentWeekStart - creditStartedAt, currentWeekStart - 1);
      addFocusMilliseconds(tally, unmatchedOrigin, now - currentWeekStart, now);
    } else {
      addFocusMilliseconds(tally, unmatchedOrigin, creditMs, now);
    }
  }
  lastTickAt = now;
}

function fenceUnobservedGap(now: number, deadlineMissed: boolean = false): boolean {
  if (eventCommitPending) {
    return true;
  }
  if (!deadlineMissed && !tickCredit(now, lastTickAt, TICK_MS).gapExceeded) {
    return false;
  }
  const lastProvableAt = Math.min(lastTickAt, now);
  lastTickAt = now;
  currentTabId = null;
  unmatchedOrigin = null;
  tabReadGeneration += 1;
  attentionGeneration += 1;
  attentionConfirmed = false;
  const committed = emitSpanEvents([
    ...handleInput(machine, { type: "window-focus", focused: false }, lastProvableAt),
    ...advance(machine, now),
  ]);
  if (!committed) {
    persistState();
  }
  scheduleMachineAdvance();
  revalidateAttention();
  return true;
}

function prepareMachineTransition(now: number): boolean {
  if (eventCommitPending) {
    return false;
  }
  const deadline = nextAdvanceAt(machine);
  const deadlineMissed = deadline !== null && now - deadline >= machine.gapMergeMs;
  const tallyIntervalLate = unmatchedOrigin !== null && now - lastTickAt >= TICK_MS + machine.gapMergeMs;
  if (fenceUnobservedGap(now, deadlineMissed || tallyIntervalLate)) {
    return false;
  }
  settleTally(now);
  return true;
}

function advanceMachine(now: number): boolean {
  if (!prepareMachineTransition(now)) {
    return false;
  }
  emitSpanEvents(advance(machine, now));
  scheduleMachineAdvance();
  return true;
}

function feedMachine(input: SpanInput, now: number = Date.now(), settle: boolean = true): void {
  if (eventCommitPending) {
    return;
  }
  if (settle && !prepareMachineTransition(now)) {
    return;
  }
  // Expire stale merge windows before a newly observed tab can resume them.
  const committed = emitSpanEvents([...advance(machine, now), ...handleInput(machine, input, now)]);
  // Subject changes (candidate starts, suspensions) emit no events but must
  // still survive an eviction.
  if (!committed) {
    persistState();
  }
  scheduleMachineAdvance();
}

function invalidateTabVerdict(now: number): void {
  if (eventCommitPending) {
    return;
  }
  currentTabId = null;
  unmatchedOrigin = null;
  tabReadGeneration += 1;
  lastTickAt = now;
  const committed = emitSpanEvents(handleInput(machine, { type: "active-tab", ruleId: null }, now));
  if (!committed) {
    persistState();
  }
  scheduleMachineAdvance();
}

function failClosedAttention(now: number): void {
  attentionConfirmed = false;
  focusedWindowId = null;
  invalidateTabVerdict(now);
  feedMachine({ type: "idle", state: "idle" }, now, false);
  feedMachine({ type: "window-focus", focused: false }, now, false);
}

function requestRules(): void {
  sendToHost({ type: "get-rules" });
}

function requestCollectionState(): void {
  sendToHost({ type: "get-collection-state" });
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
  if (!collectionEnabled || collectionId === undefined || pendingStorageWrites > 0 || storageWriteFailed) {
    return;
  }
  for (const event of outbox.snapshot()) {
    const key = spanKey(event);
    if (inFlightSpans.has(key)) {
      continue;
    }
    if (sendToHost({ type: "span-event", event, collectionId })) {
      inFlightSpans.add(key);
    } else {
      scheduleReconnect();
      break;
    }
  }
}

function spanKey(event: SpanEvent): string {
  return `${event.event}\u0000${event.externalSessionId}\u0000${event.ruleId}\u0000${event.occurredAt}`;
}

function sameSpanEvent(left: SpanEvent, right: SpanEvent): boolean {
  return spanKey(left) === spanKey(right);
}

function isStoredOutboxNamespace(value: unknown): value is string {
  return isIdentityNamespace(value) ||
    (collectionId !== undefined && value === `legacy:${collectionId}` &&
      /^legacy:[A-Za-z0-9-]{1,128}$/.test(value));
}

function isRule(value: unknown): value is UrlRule {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate["id"] === "string" && typeof candidate["pattern"] === "string";
}

function collectionDetails(message: Record<string, unknown>): { enabled: boolean; id: string | undefined; namespace: string | undefined } {
  const id = message["collectionId"];
  const namespace = message["collectionNamespace"];
  const usableId = typeof id === "string" && id.length > 0 ? id : undefined;
  const usableNamespace = isIdentityNamespace(namespace)
    ? namespace
    : undefined;
  return {
    enabled: message["collectionEnabled"] === true && usableId !== undefined && usableNamespace !== undefined,
    id: usableId,
    namespace: usableNamespace,
  };
}

interface NamespaceReservation {
  requestId: string;
  sourceNamespace: string;
  targetNamespace: string;
  action: "reserve" | "release";
}

function namespaceReservationDetails(message: Record<string, unknown>): NamespaceReservation | undefined {
  const value = message["namespaceReservation"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const reservation = value as Record<string, unknown>;
  const requestId = reservation["requestId"];
  const sourceNamespace = reservation["sourceNamespace"];
  const targetNamespace = reservation["targetNamespace"];
  const action = reservation["action"];
  if (typeof requestId !== "string" || requestId.trim().length === 0 ||
    !isIdentityNamespace(sourceNamespace) || !isIdentityNamespace(targetNamespace) ||
    (action !== "reserve" && action !== "release")) {
    return undefined;
  }
  return { requestId, sourceNamespace, targetNamespace, action };
}

function acknowledgeNamespaceReservation(
  reservation: NamespaceReservation,
  acknowledgement: "reserved" | "rejected" | "released",
): void {
  sendToHost({
    type: "namespace-reservation",
    requestId: reservation.requestId,
    acknowledgement,
  });
}

function applyNamespaceReservation(message: Record<string, unknown>): void {
  const reservation = namespaceReservationDetails(message);
  if (reservation === undefined || reservation.sourceNamespace !== collectionNamespace) {
    return;
  }
  if (reservationPersistencePending.has(reservation.requestId)) {
    return;
  }
  if (reservation.action === "release") {
    if (!reservedOutboxNamespaces.delete(reservation.targetNamespace)) {
      acknowledgeNamespaceReservation(reservation, "released");
      return;
    }
    reservationPersistencePending.add(reservation.requestId);
    void persistState().then((persisted) => {
      reservationPersistencePending.delete(reservation.requestId);
      if (persisted) acknowledgeNamespaceReservation(reservation, "released");
    });
    return;
  }
  if (reservedOutboxNamespaces.has(reservation.targetNamespace)) {
    acknowledgeNamespaceReservation(reservation, "reserved");
    return;
  }
  if (!canActivateOutboxNamespace(
    outboxes,
    reservation.targetNamespace,
    collectionNamespace,
    reservedOutboxNamespaces,
  )) {
    acknowledgeNamespaceReservation(reservation, "rejected");
    return;
  }
  reservedOutboxNamespaces.add(reservation.targetNamespace);
  outboxes.set(reservation.targetNamespace, outboxes.get(reservation.targetNamespace) ?? new Outbox<SpanEvent>());
  reservationPersistencePending.add(reservation.requestId);
  void persistState().then((persisted) => {
    reservationPersistencePending.delete(reservation.requestId);
    if (persisted) acknowledgeNamespaceReservation(reservation, "reserved");
  });
}

function migrateLegacyOutbox(namespace: string, id: string): boolean {
  const legacyNamespace = `legacy:${id}`;
  if (namespace === legacyNamespace) {
    return true;
  }
  const legacy = outboxes.get(legacyNamespace);
  if (legacy === undefined) {
    return true;
  }
  const target = outboxes.get(namespace) ?? new Outbox<SpanEvent>();
  const seen = new Set(target.snapshot().map(spanKey));
  const additions = legacy.snapshot().filter((event) => {
    const key = spanKey(event);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  if (target.remainingCapacity < additions.length) {
    return false;
  }
  for (const event of additions) {
    if (!target.push(event)) return false;
  }
  legacy.clear();
  outboxes.delete(legacyNamespace);
  outboxes.set(namespace, target);
  return true;
}

function activateOutbox(namespace: string, id: string): boolean {
  if (!canActivateOutboxNamespace(outboxes, namespace, collectionNamespace, reservedOutboxNamespaces)) {
    return false;
  }
  if (!migrateLegacyOutbox(namespace, id)) {
    return false;
  }
  const changedNamespace = collectionNamespace !== namespace;
  collectionNamespace = namespace;
  outbox = outboxes.get(namespace) ?? new Outbox<SpanEvent>();
  reservedOutboxNamespaces.delete(namespace);
  capturePaused = capturePausedNamespaces.get(namespace) === true || outbox.remainingCapacity === 0;
  if (changedNamespace) {
    captureResumePending = false;
    pauseAwaitingHostConfirmation = capturePaused;
  }
  outboxes.delete(namespace);
  outboxes.set(namespace, outbox);
  return true;
}

function pruneOutboxes(): void {
  pruneOutboxNamespaces(outboxes, collectionNamespace, undefined, reservedOutboxNamespaces);
  for (const namespace of capturePausedNamespaces.keys()) {
    if (!outboxes.has(namespace) && namespace !== collectionNamespace) {
      capturePausedNamespaces.delete(namespace);
    }
  }
}

function applyCollectionState(message: Record<string, unknown>): "changed" | "unchanged" | "blocked" {
  const { enabled, id, namespace } = collectionDetails(message);
  if (!enabled || id === undefined || namespace === undefined) {
    const changed = collectionEnabled || collectionId !== undefined;
    collectionEnabled = false;
    collectionId = undefined;
    collectionNamespace = undefined;
    capturePaused = false;
    captureResumePending = false;
    pauseAwaitingHostConfirmation = false;
    rules = [];
    resetLocalCollectionState();
    clearTally(tally);
    persistState();
    return changed ? "changed" : "unchanged";
  }
  const legacyUpgrade = collectionId === id && collectionNamespace === `legacy:${id}`;
  const changed = !legacyUpgrade && (collectionId !== id || collectionNamespace !== namespace);
  if (changed && !canActivateOutboxNamespace(outboxes, namespace, collectionNamespace, reservedOutboxNamespaces)) {
    collectionEnabled = false;
    collectionId = undefined;
    collectionNamespace = undefined;
    rules = [];
    resetLocalCollectionState();
    clearTally(tally);
    persistState();
    return "blocked";
  }
  if (changed) {
    collectionEnabled = false;
    collectionId = undefined;
    rules = [];
    resetLocalCollectionState();
    clearTally(tally);
  }
  collectionEnabled = true;
  collectionId = id;
  if (!activateOutbox(namespace, id)) {
    collectionEnabled = false;
    collectionId = undefined;
    collectionNamespace = undefined;
    rules = [];
    resetLocalCollectionState();
    clearTally(tally);
    persistState();
    return "blocked";
  }
  if (storageWriteFailed) {
    pauseCapture();
  }
  if (capturePaused && pauseAwaitingHostConfirmation) {
    sendToHost({ type: "capture-paused", collectionId: id });
  }
  if (changed || legacyUpgrade) {
    persistState();
  }
  return changed ? "changed" : "unchanged";
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
    if (eventCommitPending) {
      deferredHostMessages.push(payload);
      return;
    }
    handleHostMessage(payload);
  });
  opened.onDisconnect.addListener(() => {
    if (port === opened) {
      port = null;
    }
    inFlightSpans.clear();
    scheduleReconnect();
  });
  requestRules();
}

function handleHostMessage(payload: Record<string, unknown>): void {
  if (payload["type"] === "span-ack" && payload["collectionId"] === collectionId && isSpanEvent(payload["event"])) {
    const event = payload["event"];
    inFlightSpans.delete(spanKey(event));
    if (outbox.remove((candidate) => sameSpanEvent(candidate, event))) {
      persistState();
    }
    flushOutbox();
    return;
  }
  if (payload["type"] === "span-retry" && payload["collectionId"] === collectionId && isSpanEvent(payload["event"])) {
    inFlightSpans.delete(spanKey(payload["event"]));
    scheduleReconnect();
    return;
  }
  if (payload["type"] === "clear-tally") {
    clearTally(tally);
    lastTickAt = Date.now();
    persistState();
    sendTally();
    return;
  }
  if (payload["type"] === "collection-state") {
    if (applyCollectionState(payload) === "changed" && collectionEnabled) {
      requestRules();
    }
    applyCapturePause(payload);
    applyNamespaceReservation(payload);
    return;
  }
  if (payload["type"] === "rules") {
    const collectionChanged = applyCollectionState(payload);
    if (collectionChanged === "blocked") {
      return;
    }
    applyCapturePause(payload);
    applyNamespaceReservation(payload);
    const list = payload["rules"];
    rules = collectionEnabled && !capturePaused && !captureResumePending && Array.isArray(list) ? list.filter(isRule) : [];
    reconnectAttempt = 0;
    if (collectionChanged === "changed") {
      revalidateAttention();
    } else {
      reApplyActiveTab();
    }
    flushOutbox();
    sendTally();
  }
}

function drainDeferredHostMessages(): void {
  while (!eventCommitPending && deferredHostMessages.length > 0) {
    const payload = deferredHostMessages.shift();
    if (payload !== undefined) {
      handleHostMessage(payload);
    }
  }
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

function beginTabRead(now: number = Date.now()): number | null {
  if (!prepareMachineTransition(now)) {
    return null;
  }
  currentTabId = null;
  unmatchedOrigin = null;
  tabReadGeneration += 1;
  feedMachine({ type: "active-tab", ruleId: null }, now, false);
  return tabReadGeneration;
}

function canApplyTabRead(tab: chrome.tabs.Tab, windowId: number, generation: number): boolean {
  return attentionConfirmed &&
    tabReadGeneration === generation &&
    focusedWindowId === windowId &&
    tab.windowId === windowId;
}

function watchActiveTab(windowId: number, generation: number | null = beginTabRead()): void {
  if (generation === null) {
    return;
  }
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
  const generation = beginTabRead();
  if (generation === null) {
    return;
  }
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
function revalidateAttention(focusedWindow: number | null = null): void {
  const generation = attentionGeneration + 1;
  attentionGeneration = generation;
  attentionConfirmed = false;
  invalidateTabVerdict(Date.now());
  const window = focusedWindow === null
    ? chrome.windows.getLastFocused()
    : Promise.resolve({ focused: true, id: focusedWindow } as chrome.windows.Window);
  void Promise.all([chrome.idle.queryState(IDLE_DETECTION_SECONDS), window])
    .then(([state, win]) => {
      if (attentionGeneration !== generation) {
        return;
      }
      const focused = win.focused === true && win.id !== undefined;
      focusedWindowId = focused ? (win.id ?? null) : null;
      feedMachine({ type: "idle", state: state as IdleState });
      if (attentionGeneration !== generation) {
        return;
      }
      feedMachine({ type: "window-focus", focused });
      if (attentionGeneration !== generation) {
        return;
      }
      attentionConfirmed = true;
      if (focused && win.id !== undefined) {
        watchActiveTab(win.id);
      }
    })
    .catch(() => {
      if (attentionGeneration !== generation) {
        return;
      }
      failClosedAttention(Date.now());
    });
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  void initialized.then(() => {
    if (!attentionConfirmed) {
      const generation = beginTabRead();
      if (generation !== null) {
        revalidateAttention();
      }
      return;
    }
    // A tab switch in a window the user is not looking at must not move the
    // state machine.
    if (!shouldApplyTabActivation(activeInfo.windowId, focusedWindowId)) {
      return;
    }
    const generation = beginTabRead();
    if (generation === null) {
      return;
    }
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
    const generation = beginTabRead();
    if (generation === null) {
      return;
    }
    attentionGeneration += 1;
    if (!attentionConfirmed) {
      if (!focused) {
        focusedWindowId = null;
        feedMachine({ type: "window-focus", focused: false }, Date.now(), false);
        return;
      }
      revalidateAttention(windowId);
      return;
    }
    focusedWindowId = focused ? windowId : null;
    feedMachine({ type: "window-focus", focused }, Date.now(), false);
    if (focused) {
      watchActiveTab(windowId, generation);
    }
  });
});

chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS);
chrome.idle.onStateChanged.addListener((state) => {
  void initialized.then(() => {
    attentionGeneration += 1;
    if (!attentionConfirmed) {
      revalidateAttention();
      return;
    }
    feedMachine({ type: "idle", state: state as IdleState });
  });
});

// Alarm-driven tick: unlike an in-memory interval, this survives routine MV3
// worker eviction. The wall-clock delta is clamped and gaps trigger
// re-validation, so laptop sleep cannot credit hours to a stale origin.
function runTick(): void {
  if (eventCommitPending) {
    return;
  }
  if (storageWriteFailed) {
    if (pendingStorageWrites === 0) void persistState();
    return;
  }
  const now = Date.now();
  requestCollectionState();
  if (!advanceMachine(now)) {
    return;
  }
  if (rollTallyIntoCurrentWeek(tally, now)) {
    persistState();
  }
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
        if (port === null) {
          connect();
        } else {
          flushOutbox();
        }
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
    .get([TALLY_STORAGE_KEY, OUTBOX_STORAGE_KEY, OUTBOX_NAMESPACES_STORAGE_KEY, OUTBOX_NAMESPACE_RESERVATIONS_STORAGE_KEY, MACHINE_STORAGE_KEY, LAST_TICK_STORAGE_KEY, COLLECTION_ID_STORAGE_KEY, COLLECTION_NAMESPACE_STORAGE_KEY, CAPTURE_PAUSED_STORAGE_KEY, CAPTURE_PAUSED_NAMESPACES_STORAGE_KEY])
    .catch(() => undefined);
  const now = Date.now();
  const startup = parseStartupStorage(stored, now);
  tally = startup.tally;
  collectionId = startup.collectionId;
  collectionNamespace = startup.collectionNamespace;
  const storedOutboxes = stored?.[OUTBOX_NAMESPACES_STORAGE_KEY];
  if (typeof storedOutboxes === "object" && storedOutboxes !== null && !Array.isArray(storedOutboxes)) {
    for (const [namespace, queued] of Object.entries(storedOutboxes as Record<string, unknown>)) {
      if (isStoredOutboxNamespace(namespace) && Array.isArray(queued)) {
        const events = queued.filter(isSpanEvent);
        if (events.length > 0) {
          outboxes.set(namespace, new Outbox<SpanEvent>(undefined, events));
        }
      }
    }
  }
  const storedReservations = stored?.[OUTBOX_NAMESPACE_RESERVATIONS_STORAGE_KEY];
  if (Array.isArray(storedReservations)) {
    for (const namespace of storedReservations) {
      if (isIdentityNamespace(namespace)) {
        reservedOutboxNamespaces.add(namespace);
        outboxes.set(namespace, outboxes.get(namespace) ?? new Outbox<SpanEvent>());
      }
    }
  }
  const storedPaused = stored?.[CAPTURE_PAUSED_NAMESPACES_STORAGE_KEY];
  if (typeof storedPaused === "object" && storedPaused !== null && !Array.isArray(storedPaused)) {
    for (const [namespace, paused] of Object.entries(storedPaused as Record<string, unknown>)) {
      if (isStoredOutboxNamespace(namespace) && paused === true) capturePausedNamespaces.set(namespace, true);
    }
  }
  if (collectionId !== undefined && collectionNamespace !== undefined) {
    outbox = outboxes.get(collectionNamespace) ?? new Outbox<SpanEvent>();
    outboxes.set(collectionNamespace, outbox);
    for (const event of startup.queuedEvents) {
      if (!outbox.snapshot().some((candidate) => sameSpanEvent(candidate, event)) && !outbox.push(event)) {
        capturePaused = true;
        capturePausedNamespaces.set(collectionNamespace, true);
      }
    }
    capturePaused ||= capturePausedNamespaces.get(collectionNamespace) === true || outbox.remainingCapacity === 0;
    pauseAwaitingHostConfirmation = capturePaused;
  } else if (collectionId !== undefined) {
    activateOutbox(`legacy:${collectionId}`, collectionId);
    for (const event of startup.queuedEvents) {
      if (!outbox.push(event)) {
        capturePaused = true;
        if (collectionNamespace !== undefined) capturePausedNamespaces.set(collectionNamespace, true);
      }
    }
  }
  capturePaused ||= stored?.[CAPTURE_PAUSED_STORAGE_KEY] === true;
  if (capturePaused && collectionNamespace !== undefined) {
    capturePausedNamespaces.set(collectionNamespace, true);
    pauseAwaitingHostConfirmation = true;
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
