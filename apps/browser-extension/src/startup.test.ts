import { describe, expect, it } from "vitest";

import { parseStartupStorage } from "./startup.js";

const VALID_EVENT = {
  event: "started",
  externalSessionId: "s1",
  ruleId: "r1",
  occurredAt: "2026-08-09T12:00:00.000Z",
};

describe("parseStartupStorage", () => {
  it("returns fresh empty state when storage is unavailable", () => {
    // The background's .catch(() => boot(undefined)) path: a rejected
    // storage read must still boot the extension with fresh state.
    expect(parseStartupStorage(undefined)).toEqual({
      tallyEntries: {},
      queuedEvents: [],
      machineSnapshot: undefined,
    });
  });

  it("returns fresh empty state for garbage storage", () => {
    expect(
      parseStartupStorage({
        unmatchedTally: "nope",
        spanOutbox: 42,
        spanMachine: null,
      }),
    ).toEqual({ tallyEntries: {}, queuedEvents: [], machineSnapshot: null });
  });

  it("keeps valid tally entries and drops malformed ones", () => {
    const parsed = parseStartupStorage({
      unmatchedTally: { "quickbooks.com": 75, bad: "x", negative: -3 },
    });
    expect(parsed.tallyEntries).toEqual({ "quickbooks.com": 75 });
  });

  it("keeps valid queued events and drops malformed ones", () => {
    const parsed = parseStartupStorage({
      spanOutbox: [VALID_EVENT, { event: "exploded" }, "junk", null],
    });
    expect(parsed.queuedEvents).toEqual([VALID_EVENT]);
  });

  it("passes the machine snapshot through for restoreMachine to validate", () => {
    const snapshot = { version: 1, active: null, suspended: [] };
    expect(parseStartupStorage({ spanMachine: snapshot }).machineSnapshot).toEqual(snapshot);
  });
});
