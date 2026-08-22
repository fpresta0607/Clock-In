import { describe, expect, it } from "vitest";

import {
  advance,
  createSpanMachine,
  handleInput,
  restoreMachine,
  snapshotMachine,
  type RestoreResult,
  type SpanEvent,
  type SpanMachine,
} from "./spans.js";

const T0 = Date.UTC(2026, 7, 9, 12, 0, 0); // 2026-08-09T12:00:00.000Z
const iso = (ms: number) => new Date(ms).toISOString();

function makeMachine(): SpanMachine {
  let next = 0;
  return createSpanMachine({ newSessionId: () => `span-${++next}` });
}

function focusTab(machine: SpanMachine, ruleId: string | null, at: number): SpanEvent[] {
  return handleInput(machine, { type: "active-tab", ruleId }, at);
}

/** Drives the machine: focus rule A at t=0 and run `ms` of time. */
function openSpan(ms: number): { machine: SpanMachine; emitted: SpanEvent[] } {
  const machine = makeMachine();
  const emitted: SpanEvent[] = [];
  emitted.push(...focusTab(machine, "rule-a", T0));
  for (let t = 1_000; t <= ms; t += 1_000) {
    emitted.push(...advance(machine, T0 + t));
  }
  return { machine, emitted };
}

describe("span opening (dwell)", () => {
  it("emits nothing for a 14 s glance", () => {
    const { emitted } = openSpan(14_000);
    expect(emitted).toEqual([]);
  });

  it("opens a span at 15 s, stamped at the moment focus began", () => {
    const { emitted } = openSpan(15_000);
    expect(emitted).toEqual([
      {
        event: "started",
        externalSessionId: "span-1",
        ruleId: "rule-a",
        occurredAt: iso(T0),
      },
    ]);
  });

  it("a look-away before the dwell completes produces nothing, ever", () => {
    const machine = makeMachine();
    const emitted: SpanEvent[] = [];
    emitted.push(...focusTab(machine, "rule-a", T0));
    emitted.push(...advance(machine, T0 + 10_000));
    // Away to an unmatched tab, long enough to outlast the merge window.
    emitted.push(...focusTab(machine, null, T0 + 10_000));
    emitted.push(...advance(machine, T0 + 26_000));
    emitted.push(...focusTab(machine, "rule-a", T0 + 26_000));
    emitted.push(...advance(machine, T0 + 40_000));
    // The candidacy restarted at T0+26 s, so 14 s later there is still nothing.
    expect(emitted).toEqual([]);
  });
});

describe("heartbeats", () => {
  it("heartbeats every 60 s while the span holds attention", () => {
    const { emitted } = openSpan(15_000 + 121_000);
    const kinds = emitted.map((e) => e.event);
    expect(kinds).toEqual(["started", "heartbeat", "heartbeat"]);
    expect(emitted[1]?.occurredAt).toBe(iso(T0 + 60_000));
    expect(emitted[2]?.occurredAt).toBe(iso(T0 + 120_000));
  });

  it("emits at most one heartbeat per advance even after a long sleep", () => {
    const machine = makeMachine();
    focusTab(machine, "rule-a", T0);
    advance(machine, T0 + 15_000);
    const emitted = advance(machine, T0 + 15_000 + 5 * 60_000);
    expect(emitted.map((e) => e.event)).toEqual(["heartbeat"]);
  });
});

describe("gap merging", () => {
  it("merges a sub-15 s tab flip into the surrounding span", () => {
    const machine = makeMachine();
    const emitted: SpanEvent[] = [];
    emitted.push(...focusTab(machine, "rule-a", T0));
    emitted.push(...advance(machine, T0 + 15_000)); // span opens
    // Flip away to an unmatched tab for 10 s, then back.
    emitted.push(...focusTab(machine, null, T0 + 20_000));
    emitted.push(...advance(machine, T0 + 25_000));
    emitted.push(...focusTab(machine, "rule-a", T0 + 30_000));
    emitted.push(...advance(machine, T0 + 40_000));
    emitted.push(...advance(machine, T0 + 61_000)); // heartbeat on the merged span
    expect(emitted.map((e) => e.event)).toEqual(["started", "heartbeat"]);
    expect(emitted.every((e) => e.externalSessionId === "span-1")).toBe(true);
  });

  it("merges quick flips between two matched tabs when returning inside the window", () => {
    const machine = makeMachine();
    const emitted: SpanEvent[] = [];
    emitted.push(...focusTab(machine, "rule-a", T0));
    emitted.push(...advance(machine, T0 + 15_000)); // span A opens
    emitted.push(...focusTab(machine, "rule-b", T0 + 20_000));
    emitted.push(...advance(machine, T0 + 24_000));
    emitted.push(...focusTab(machine, "rule-a", T0 + 25_000)); // back inside 15 s
    emitted.push(...advance(machine, T0 + 50_000));
    // Span A survived; rule B never dwelled long enough to open.
    expect(emitted.map((e) => e.event)).toEqual(["started"]);
    expect(emitted[0]?.ruleId).toBe("rule-a");
  });

  it("ends the span at the moment attention left once the gap outlasts 15 s", () => {
    const machine = makeMachine();
    const emitted: SpanEvent[] = [];
    emitted.push(...focusTab(machine, "rule-a", T0));
    emitted.push(...advance(machine, T0 + 15_000));
    emitted.push(...focusTab(machine, null, T0 + 30_000));
    emitted.push(...advance(machine, T0 + 44_999));
    expect(emitted.map((e) => e.event)).toEqual(["started"]);
    emitted.push(...advance(machine, T0 + 45_000));
    expect(emitted.map((e) => e.event)).toEqual(["started", "ended"]);
    expect(emitted[1]).toMatchObject({
      externalSessionId: "span-1",
      ruleId: "rule-a",
      occurredAt: iso(T0 + 30_000),
    });
  });

  it("does not heartbeat while suspended in the merge window", () => {
    const machine = makeMachine();
    const emitted: SpanEvent[] = [];
    emitted.push(...focusTab(machine, "rule-a", T0));
    emitted.push(...advance(machine, T0 + 15_000));
    emitted.push(...focusTab(machine, null, T0 + 50_000));
    emitted.push(...advance(machine, T0 + 61_000));
    emitted.push(...focusTab(machine, "rule-a", T0 + 62_000)); // resumes inside window
    // Next heartbeat anchors to the span clock: 60 s after focus began.
    emitted.push(...advance(machine, T0 + 62_000));
    expect(emitted.map((e) => e.event)).toEqual(["started", "heartbeat"]);
  });
});

describe("ending conditions", () => {
  it("window blur ends the span after the merge window", () => {
    const machine = makeMachine();
    const emitted: SpanEvent[] = [];
    emitted.push(...focusTab(machine, "rule-a", T0));
    emitted.push(...advance(machine, T0 + 15_000));
    emitted.push(...handleInput(machine, { type: "window-focus", focused: false }, T0 + 20_000));
    emitted.push(...advance(machine, T0 + 35_000));
    expect(emitted.map((e) => e.event)).toEqual(["started", "ended"]);
    expect(emitted[1]?.occurredAt).toBe(iso(T0 + 20_000));
  });

  it("idle ends the span; returning active inside the window merges", () => {
    const machine = makeMachine();
    const emitted: SpanEvent[] = [];
    emitted.push(...focusTab(machine, "rule-a", T0));
    emitted.push(...advance(machine, T0 + 15_000));
    emitted.push(...handleInput(machine, { type: "idle", state: "idle" }, T0 + 20_000));
    emitted.push(...advance(machine, T0 + 25_000));
    emitted.push(...handleInput(machine, { type: "idle", state: "active" }, T0 + 25_000));
    emitted.push(...advance(machine, T0 + 60_000));
    expect(emitted.map((e) => e.event)).toEqual(["started", "heartbeat"]);
  });

  it("lock ends the span after the merge window", () => {
    const machine = makeMachine();
    const emitted: SpanEvent[] = [];
    emitted.push(...focusTab(machine, "rule-a", T0));
    emitted.push(...advance(machine, T0 + 15_000));
    emitted.push(...handleInput(machine, { type: "idle", state: "locked" }, T0 + 20_000));
    emitted.push(...advance(machine, T0 + 35_001));
    expect(emitted.map((e) => e.event)).toEqual(["started", "ended"]);
  });

  it("switching to a different matched rule ends the old span and dwells the new one", () => {
    const machine = makeMachine();
    const emitted: SpanEvent[] = [];
    emitted.push(...focusTab(machine, "rule-a", T0));
    emitted.push(...advance(machine, T0 + 15_000)); // A opens
    emitted.push(...focusTab(machine, "rule-b", T0 + 30_000));
    emitted.push(...advance(machine, T0 + 44_000)); // B at 14 s: nothing yet
    expect(emitted.map((e) => e.event)).toEqual(["started"]);
    emitted.push(...advance(machine, T0 + 45_000)); // A's gap expires; B opens
    const kinds = emitted.map((e) => e.event);
    expect(kinds).toEqual(["started", "ended", "started"]);
    expect(emitted[1]).toMatchObject({
      event: "ended",
      ruleId: "rule-a",
      externalSessionId: "span-1",
      occurredAt: iso(T0 + 30_000),
    });
    expect(emitted[2]).toMatchObject({
      event: "started",
      ruleId: "rule-b",
      externalSessionId: "span-2",
      occurredAt: iso(T0 + 30_000),
    });
  });

  it("shutdown ends open and suspended spans immediately", () => {
    const machine = makeMachine();
    const emitted: SpanEvent[] = [];
    emitted.push(...focusTab(machine, "rule-a", T0));
    emitted.push(...advance(machine, T0 + 15_000)); // A opens
    emitted.push(...focusTab(machine, "rule-b", T0 + 20_000)); // A suspended
    emitted.push(...advance(machine, T0 + 35_000)); // B opens (A already ended)
    emitted.push(...handleInput(machine, { type: "shutdown" }, T0 + 40_000));
    expect(emitted.map((e) => e.event)).toEqual(["started", "ended", "started", "ended"]);
    expect(emitted[1]).toMatchObject({ event: "ended", ruleId: "rule-a" });
    expect(emitted[3]).toMatchObject({
      event: "ended",
      ruleId: "rule-b",
      occurredAt: iso(T0 + 40_000),
    });
    // The machine is inert after shutdown.
    expect(advance(machine, T0 + 60_000)).toEqual([]);
  });
});

describe("unmatched browsing", () => {
  it("produces nothing for tabs that match no rule", () => {
    const machine = makeMachine();
    const emitted: SpanEvent[] = [];
    emitted.push(...focusTab(machine, null, T0));
    emitted.push(...advance(machine, T0 + 120_000));
    emitted.push(...focusTab(machine, null, T0 + 120_000));
    emitted.push(...advance(machine, T0 + 300_000));
    expect(emitted).toEqual([]);
  });
});

describe("durability across service-worker restarts", () => {
  /** Simulates an MV3 eviction: JSON storage round-trip into a fresh machine. */
  function restart(machine: SpanMachine, at: number): RestoreResult {
    const stored = JSON.parse(JSON.stringify(snapshotMachine(machine))) as unknown;
    return restoreMachine(stored, at, { newSessionId: () => "span-restored" });
  }

  it("a restored span ends at its last provable timestamp; the dead period is never credited", () => {
    const machine = makeMachine();
    focusTab(machine, "rule-a", T0);
    advance(machine, T0 + 15_000); // span-1 opens
    advance(machine, T0 + 61_000); // heartbeat: +61 s is the last provable attention

    const eightHours = 8 * 60 * 60 * 1000;
    const { machine: restored, emitted } = restart(machine, T0 + eightHours);
    // The prior span is ended at its last heartbeat, not at restore time:
    // the eight unprovable hours are credited to nobody.
    expect(emitted).toEqual([
      {
        event: "ended",
        externalSessionId: "span-1",
        ruleId: "rule-a",
        occurredAt: iso(T0 + 61_000),
      },
    ]);
    expect(restored.active).toBeNull();
    expect(restored.suspended).toEqual([]);

    // The same tab is still focused: a FRESH span dwells from re-derivation.
    const after: SpanEvent[] = [];
    after.push(...focusTab(restored, "rule-a", T0 + eightHours));
    after.push(...advance(restored, T0 + eightHours + 15_000));
    expect(after).toEqual([
      {
        event: "started",
        externalSessionId: "span-restored",
        ruleId: "rule-a",
        occurredAt: iso(T0 + eightHours),
      },
    ]);
  });

  it("an eviction without any shutdown event truncates the span the same way", () => {
    // No shutdown input, no final persist: only the last snapshot survives.
    const machine = makeMachine();
    focusTab(machine, "rule-a", T0);
    advance(machine, T0 + 15_000); // span-1, no heartbeat yet: provable = span start

    const { emitted } = restart(machine, T0 + 3_600_000);
    expect(emitted).toEqual([
      {
        event: "ended",
        externalSessionId: "span-1",
        ruleId: "rule-a",
        occurredAt: iso(T0),
      },
    ]);
  });

  it("a restored dwell candidate is dropped and re-dwells from restore time", () => {
    const machine = makeMachine();
    focusTab(machine, "rule-a", T0);
    advance(machine, T0 + 10_000); // 10 s into the dwell, nothing emitted

    const { machine: restored, emitted } = restart(machine, T0 + 300_000);
    // A candidate never emitted `started`, so nothing needs ending; the dead
    // period must not count toward the fresh dwell either.
    expect(emitted).toEqual([]);
    expect(restored.active).toBeNull();

    const after: SpanEvent[] = [];
    after.push(...focusTab(restored, "rule-a", T0 + 300_000));
    after.push(...advance(restored, T0 + 314_999));
    expect(after).toEqual([]);
    after.push(...advance(restored, T0 + 315_000));
    expect(after).toEqual([
      {
        event: "started",
        externalSessionId: "span-restored",
        ruleId: "rule-a",
        occurredAt: iso(T0 + 300_000),
      },
    ]);
  });

  it("a restored suspended span still ends at its original gap start", () => {
    const machine = makeMachine();
    focusTab(machine, "rule-a", T0);
    advance(machine, T0 + 15_000); // span-1 opens
    focusTab(machine, "rule-b", T0 + 30_000); // A suspends at +30 s, B dwells

    // The gap was already provably running before the eviction, so it stays
    // and expires at its original start; B (a candidate) is dropped.
    const { machine: restored, emitted } = restart(machine, T0 + 3_600_000);
    expect(emitted).toEqual([]);
    expect(advance(restored, T0 + 3_600_000)).toEqual([
      {
        event: "ended",
        externalSessionId: "span-1",
        ruleId: "rule-a",
        occurredAt: iso(T0 + 30_000),
      },
    ]);
  });

  it("a corrupt snapshot restores to a fresh, silent machine", () => {
    const corrupt: unknown[] = [
      null,
      42,
      "junk",
      { version: 99 },
      { version: 1, suspended: "nope" },
      { version: 1, active: {}, suspended: [] },
    ];
    for (const stored of corrupt) {
      const { machine: restored, emitted } = restoreMachine(stored, T0, {
        newSessionId: () => "span-x",
      });
      expect(emitted).toEqual([]);
      expect(restored.active).toBeNull();
      expect(restored.suspended).toEqual([]);
      expect(advance(restored, T0 + 120_000)).toEqual([]);
    }
  });
});
