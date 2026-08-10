//! Validation at the extension-storage boundary. A corrupt or unavailable
//! read must boot from fresh state, while valid queued verdicts survive.

import type { SpanEvent } from "./spans.js";
import { OUTBOX_STORAGE_KEY } from "./outbox.js";
import { restoreTally, TALLY_STORAGE_KEY, type Tally } from "./tally.js";

export const MACHINE_STORAGE_KEY = "spanMachine";
export const LAST_TICK_STORAGE_KEY = "lastTickAt";
export const COLLECTION_ID_STORAGE_KEY = "browserCollectionId";
export const CAPTURE_PAUSED_STORAGE_KEY = "spanCapturePaused";
export const CAPTURE_PAUSED_NAMESPACES_STORAGE_KEY = "spanCapturePausedByNamespace";

export interface StartupStorage {
  tally: Tally;
  queuedEvents: SpanEvent[];
  machineSnapshot: unknown;
  lastTickAt: number | undefined;
  collectionId: string | undefined;
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

export function parseStartupStorage(value: unknown, now: number = Date.now()): StartupStorage {
  const stored = record(value);
  if (stored === null) {
    return { tally: restoreTally(undefined, now), queuedEvents: [], machineSnapshot: undefined, lastTickAt: undefined, collectionId: undefined };
  }

  const queued = stored[OUTBOX_STORAGE_KEY];
  const lastTickAt = stored[LAST_TICK_STORAGE_KEY];
  const collectionId = stored[COLLECTION_ID_STORAGE_KEY];
  return {
    tally: restoreTally(stored[TALLY_STORAGE_KEY], now),
    queuedEvents: Array.isArray(queued) ? queued.filter(isSpanEvent) : [],
    machineSnapshot: stored[MACHINE_STORAGE_KEY],
    lastTickAt: isTimestamp(lastTickAt) ? lastTickAt : undefined,
    collectionId: typeof collectionId === "string" && collectionId.length > 0 ? collectionId : undefined,
  };
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
