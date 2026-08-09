import { describe, expect, it } from "vitest";

import { parseStartupStorage } from "./startup.js";

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);
const WEEK_START = Date.UTC(2026, 7, 3, 0, 0, 0);

const VALID_EVENT = {
  event: "started",
  externalSessionId: "s1",
  ruleId: "r1",
  occurredAt: "2026-08-09T12:00:00.000Z",
};

describe("parseStartupStorage", () => {
  it("returns fresh empty state when storage is unavailable", () => {
    expect(parseStartupStorage(undefined, NOW)).toEqual({
      tally: { weekStart: WEEK_START, entries: {} },
      queuedEvents: [],
      machineSnapshot: undefined,
      lastTickAt: undefined,
      collectionId: undefined,
    });
  });

  it("returns fresh empty state for garbage storage", () => {
    expect(
      parseStartupStorage({
        unmatchedTally: "nope",
        spanOutbox: 42,
        spanMachine: null,
      }, NOW),
    ).toEqual({ tally: { weekStart: WEEK_START, entries: {} }, queuedEvents: [], machineSnapshot: null, lastTickAt: undefined, collectionId: undefined });
  });

  it("keeps valid tally entries and drops malformed ones", () => {
    const parsed = parseStartupStorage({
      unmatchedTally: { weekStart: WEEK_START, entries: { "quickbooks.com": 75, bad: "x", negative: -3 } },
    }, NOW);
    expect(parsed.tally).toEqual({ weekStart: WEEK_START, entries: { "quickbooks.com": 75 } });
  });

  it("drops a tally carried over from a prior week", () => {
    const parsed = parseStartupStorage({
      unmatchedTally: { weekStart: WEEK_START - 7 * 86_400_000, entries: { "quickbooks.com": 75 } },
    }, NOW);
    expect(parsed.tally).toEqual({ weekStart: WEEK_START, entries: {} });
  });

  it("keeps valid queued events and drops malformed ones", () => {
    const parsed = parseStartupStorage({
      spanOutbox: [VALID_EVENT, { event: "exploded" }, "junk", null],
    }, NOW);
    expect(parsed.queuedEvents).toEqual([VALID_EVENT]);
  });

  it("passes the machine snapshot through for restoreMachine to validate", () => {
    const snapshot = { version: 1, active: null, suspended: [] };
    expect(parseStartupStorage({ spanMachine: snapshot }, NOW).machineSnapshot).toEqual(snapshot);
  });

  it("restores only a valid persisted tick timestamp", () => {
    expect(parseStartupStorage({ lastTickAt: 1_786_291_200_000 }, NOW).lastTickAt).toBe(1_786_291_200_000);
    expect(parseStartupStorage({ lastTickAt: -1 }, NOW).lastTickAt).toBeUndefined();
    expect(parseStartupStorage({ lastTickAt: "yesterday" }, NOW).lastTickAt).toBeUndefined();
  });

  it("restores only a usable persisted collection identity", () => {
    expect(parseStartupStorage({ browserCollectionId: "collection-1" }, NOW).collectionId).toBe("collection-1");
    expect(parseStartupStorage({ browserCollectionId: "" }, NOW).collectionId).toBeUndefined();
  });
});
