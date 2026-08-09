//! The browser-span state machine: pure, over an injected clock and event
//! stream, with no browser APIs. `background.ts` feeds it tab/window/idle
//! inputs and calls `advance` on a timer; the machine emits only lifecycle
//! transitions (`started`, `heartbeat`, `ended`) for rule hits, never ticks
//! and never anything about unmatched browsing.
//!
//! Lifecycle (per the phase 3 design):
//! - A span opens only after a matched tab has held attention (browser window
//!   focused, machine not idle) for `dwellMs` (15 s).
//! - Gaps shorter than `gapMergeMs` (15 s) merge into the surrounding span:
//!   quick tab flips and look-aways emit nothing.
//! - An open span heartbeats every `heartbeatMs` (60 s) while it holds
//!   attention.
//! - `ended` fires when a gap outlasts the merge window (tab switch, window
//!   blur, idle, lock) or immediately on shutdown; its `occurredAt` is the
//!   moment attention was lost, not when the grace period expired.
//!
//! Durability: `snapshotMachine`/`restoreMachine` carry the subjects (open
//! span, dwell candidate, suspended merge-window entries, session ids) and
//! the snapshot's `savedAt` across MV3 service-worker restarts. A restored
//! active subject starts suspended at `savedAt`, the last time attention was
//! provable. Startup re-derivation can resume it only inside the normal merge
//! window; a longer shutdown or eviction closes it at `savedAt`, so dead time
//! is never credited to a project.

export type SpanEventKind = "started" | "heartbeat" | "ended";

/** One verdict event; the payload of the host's `span-event` message. */
export interface SpanEvent {
  event: SpanEventKind;
  externalSessionId: string;
  ruleId: string;
  occurredAt: string;
}

export type IdleState = "active" | "idle" | "locked";

export type SpanInput =
  /** The active tab's match verdict changed (tab switch or URL change). */
  | { type: "active-tab"; ruleId: string | null }
  /** The browser window gained or lost OS focus. */
  | { type: "window-focus"; focused: boolean }
  /** The machine went active/idle/locked per the browser's idle API. */
  | { type: "idle"; state: IdleState }
  /** The browser is shutting down; open spans end immediately. */
  | { type: "shutdown" };

export interface SpanMachineOptions {
  dwellMs?: number;
  gapMergeMs?: number;
  heartbeatMs?: number;
  /** Injected so tests get deterministic span ids. Defaults to crypto.randomUUID. */
  newSessionId?: () => string;
}

export const DEFAULT_DWELL_MS = 15_000;
export const DEFAULT_GAP_MERGE_MS = 15_000;
export const DEFAULT_HEARTBEAT_MS = 60_000;

/** A candidate (dwell pending) or an open span for one rule. */
interface Subject {
  ruleId: string;
  /** Attention first arrived; dwell and the span's start anchor here. */
  since: number;
  sessionId: string | null;
  lastHeartbeatAt: number;
  /** Set while attention is elsewhere; null while the subject holds attention. */
  gapSince: number | null;
}

export interface SpanMachine {
  /** The subject currently holding attention, if any. */
  active: Subject | null;
  /** Suspended subjects inside their merge window, most recent first. */
  suspended: Subject[];
  readonly dwellMs: number;
  readonly gapMergeMs: number;
  readonly heartbeatMs: number;
  readonly newSessionId: () => string;
  windowFocused: boolean;
  idleState: IdleState;
  tabRuleId: string | null;
}

export function createSpanMachine(options: SpanMachineOptions = {}): SpanMachine {
  return {
    active: null,
    suspended: [],
    dwellMs: options.dwellMs ?? DEFAULT_DWELL_MS,
    gapMergeMs: options.gapMergeMs ?? DEFAULT_GAP_MERGE_MS,
    heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    newSessionId: options.newSessionId ?? (() => crypto.randomUUID()),
    windowFocused: true,
    idleState: "active",
    tabRuleId: null,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The rule currently holding attention, or null when nothing qualifies. */
function attention(machine: SpanMachine): string | null {
  if (!machine.windowFocused || machine.idleState !== "active") {
    return null;
  }
  return machine.tabRuleId;
}

/** Re-seats subjects after an input so `active` matches current attention. */
function reconcile(machine: SpanMachine, now: number): void {
  const att = attention(machine);
  if (machine.active !== null && machine.active.ruleId !== att) {
    machine.active.gapSince = now;
    machine.suspended.unshift(machine.active);
    machine.active = null;
  }
  if (att !== null && machine.active === null) {
    const index = machine.suspended.findIndex((s) => s.ruleId === att);
    const resumed = index === -1 ? undefined : machine.suspended.splice(index, 1)[0];
    if (resumed !== undefined) {
      resumed.gapSince = null;
      machine.active = resumed;
    } else {
      machine.active = {
        ruleId: att,
        since: now,
        sessionId: null,
        lastHeartbeatAt: now,
        gapSince: null,
      };
    }
  }
}

function endSpan(subject: Subject, occurredAtMs: number): SpanEvent {
  return {
    event: "ended",
    externalSessionId: subject.sessionId ?? "",
    ruleId: subject.ruleId,
    occurredAt: iso(occurredAtMs),
  };
}

/** Feeds one browser event into the machine; returns events to emit. */
export function handleInput(
  machine: SpanMachine,
  input: SpanInput,
  now: number,
): SpanEvent[] {
  if (input.type === "shutdown") {
    const emitted: SpanEvent[] = [];
    if (machine.active?.sessionId != null) {
      emitted.push(endSpan(machine.active, now));
    }
    for (const subject of machine.suspended) {
      if (subject.sessionId != null) {
        emitted.push(endSpan(subject, subject.gapSince ?? now));
      }
    }
    machine.active = null;
    machine.suspended = [];
    machine.tabRuleId = null;
    return emitted;
  }

  switch (input.type) {
    case "active-tab":
      machine.tabRuleId = input.ruleId;
      break;
    case "window-focus":
      machine.windowFocused = input.focused;
      break;
    case "idle":
      machine.idleState = input.state;
      break;
  }
  reconcile(machine, now);
  return [];
}

/**
 * Applies time-driven transitions: dwell completion opens spans, expired
 * gaps end them, and open spans heartbeat. Call on a steady timer; `now`
 * must be monotonic wall time in milliseconds.
 */
export function advance(machine: SpanMachine, now: number): SpanEvent[] {
  const emitted: SpanEvent[] = [];

  machine.suspended = machine.suspended.filter((subject) => {
    if (subject.gapSince !== null && now - subject.gapSince >= machine.gapMergeMs) {
      if (subject.sessionId !== null) {
        emitted.push(endSpan(subject, subject.gapSince));
      }
      return false;
    }
    return true;
  });

  const active = machine.active;
  if (active === null) {
    return emitted;
  }
  if (active.sessionId === null) {
    if (now - active.since >= machine.dwellMs) {
      active.sessionId = machine.newSessionId();
      active.lastHeartbeatAt = active.since;
      emitted.push({
        event: "started",
        externalSessionId: active.sessionId,
        ruleId: active.ruleId,
        occurredAt: iso(active.since),
      });
    }
  } else if (now - active.lastHeartbeatAt >= machine.heartbeatMs) {
    active.lastHeartbeatAt = now;
    emitted.push({
      event: "heartbeat",
      externalSessionId: active.sessionId,
      ruleId: active.ruleId,
      occurredAt: iso(now),
    });
  }
  return emitted;
}

/** The next time a dwell, gap expiry, or heartbeat needs `advance`. */
export function nextAdvanceAt(machine: SpanMachine): number | null {
  const deadlines: number[] = machine.suspended
    .flatMap((subject) => subject.gapSince === null ? [] : [subject.gapSince + machine.gapMergeMs]);
  if (machine.active !== null) {
    deadlines.push(
      machine.active.sessionId === null
        ? machine.active.since + machine.dwellMs
        : machine.active.lastHeartbeatAt + machine.heartbeatMs,
    );
  }
  return deadlines.length === 0 ? null : Math.min(...deadlines);
}

/** JSON-safe subject shape for extension storage. */
interface SubjectSnapshot {
  ruleId: string;
  since: number;
  sessionId: string | null;
  lastHeartbeatAt: number;
  gapSince: number | null;
}

/** The durable machine state; versioned so old snapshots can be rejected. */
export interface SpanMachineSnapshot {
  version: 2;
  /** Wall-clock time when this exact state was last durably written. */
  savedAt: number;
  active: SubjectSnapshot | null;
  suspended: SubjectSnapshot[];
}

function subjectSnapshot(subject: Subject): SubjectSnapshot {
  return {
    ruleId: subject.ruleId,
    since: subject.since,
    sessionId: subject.sessionId,
    lastHeartbeatAt: subject.lastHeartbeatAt,
    gapSince: subject.gapSince,
  };
}

/** Serializes the subjects; options and attention inputs are re-derived live. */
export function snapshotMachine(machine: SpanMachine, savedAt: number): SpanMachineSnapshot {
  return {
    version: 2,
    savedAt,
    active: machine.active === null ? null : subjectSnapshot(machine.active),
    suspended: machine.suspended.map(subjectSnapshot),
  };
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSubjectSnapshot(value: unknown): value is SubjectSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["ruleId"] === "string" &&
    isTimestamp(candidate["since"]) &&
    (typeof candidate["sessionId"] === "string" || candidate["sessionId"] === null) &&
    isTimestamp(candidate["lastHeartbeatAt"]) &&
    (isTimestamp(candidate["gapSince"]) || candidate["gapSince"] === null)
  );
}

export interface RestoreResult {
  machine: SpanMachine;
  /** Honest closures discovered while evaluating snapshot age. */
  emitted: SpanEvent[];
}

/**
 * Rebuilds a machine from a storage snapshot. The restored active subject is
 * suspended with its gap stamped at the persisted `savedAt`; already-
 * suspended subjects keep their original gap start. `advance` immediately
 * closes anything older than the normal merge window. Anything unparseable
 * fails closed to a fresh machine: silence, not leakage.
 */
export function restoreMachine(
  snapshot: unknown,
  now: number,
  options: SpanMachineOptions = {},
): RestoreResult {
  const machine = createSpanMachine(options);
  const fresh = (): RestoreResult => ({ machine, emitted: [] });
  if (typeof snapshot !== "object" || snapshot === null) {
    return fresh();
  }
  const candidate = snapshot as Record<string, unknown>;
  if (
    candidate["version"] !== 2 ||
    !isTimestamp(candidate["savedAt"]) ||
    candidate["savedAt"] > now ||
    !Array.isArray(candidate["suspended"])
  ) {
    return fresh();
  }
  const savedAt = candidate["savedAt"];
  const suspended = candidate["suspended"];
  const active = candidate["active"];
  if (
    (active !== null && (!isSubjectSnapshot(active) || active.gapSince !== null || active.since > savedAt)) ||
    !suspended.every((subject) =>
      isSubjectSnapshot(subject) &&
      subject.gapSince !== null &&
      subject.since <= savedAt &&
      subject.gapSince <= savedAt)
  ) {
    return fresh();
  }
  machine.suspended = suspended.map((subject) => ({ ...subject }));
  if (isSubjectSnapshot(active)) {
    machine.suspended.unshift({ ...active, gapSince: savedAt });
  }
  return { machine, emitted: advance(machine, now) };
}
