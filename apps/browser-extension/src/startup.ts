//! Validation at the extension-storage boundary. A corrupt or unavailable
//! read must boot from fresh state, while valid queued verdicts survive.

import type { SpanEvent } from "./spans.js";
import { OUTBOX_STORAGE_KEY } from "./outbox.js";
import { TALLY_STORAGE_KEY } from "./tally.js";

export const MACHINE_STORAGE_KEY = "spanMachine";
export const LAST_TICK_STORAGE_KEY = "lastTickAt";

export interface StartupStorage {
  tallyEntries: Record<string, number>;
  queuedEvents: SpanEvent[];
  machineSnapshot: unknown;
  lastTickAt: number | undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isSpanEvent(value: unknown): value is SpanEvent {
  const candidate = record(value);
  return candidate !== null &&
    (candidate["event"] === "started" || candidate["event"] === "heartbeat" || candidate["event"] === "ended") &&
    typeof candidate["externalSessionId"] === "string" && candidate["externalSessionId"].length > 0 &&
    typeof candidate["ruleId"] === "string" && candidate["ruleId"].length > 0 &&
    typeof candidate["occurredAt"] === "string" && Number.isFinite(Date.parse(candidate["occurredAt"]));
}

export function parseStartupStorage(value: unknown): StartupStorage {
  const stored = record(value);
  if (stored === null) {
    return { tallyEntries: {}, queuedEvents: [], machineSnapshot: undefined, lastTickAt: undefined };
  }

  const tallyEntries: Record<string, number> = {};
  const rawTally = record(stored[TALLY_STORAGE_KEY]);
  if (rawTally !== null) {
    for (const [origin, seconds] of Object.entries(rawTally)) {
      if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
        tallyEntries[origin] = seconds;
      }
    }
  }

  const queued = stored[OUTBOX_STORAGE_KEY];
  const lastTickAt = stored[LAST_TICK_STORAGE_KEY];
  return {
    tallyEntries,
    queuedEvents: Array.isArray(queued) ? queued.filter(isSpanEvent) : [],
    machineSnapshot: stored[MACHINE_STORAGE_KEY],
    lastTickAt: isTimestamp(lastTickAt) ? lastTickAt : undefined,
  };
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
