import { describe, expect, it } from "vitest";

import {
  clipInterval,
  intersectIntervals,
  leverage,
  measureTime,
  mergeIntervals,
  summedSeconds,
  unionSeconds,
  type Interval,
} from "./intervals.js";

const at = (minutes: number): number => minutes * 60_000;
const span = (startMinutes: number, endMinutes: number): Interval => ({ start: at(startMinutes), end: at(endMinutes) });

describe("mergeIntervals", () => {
  it("leaves non-overlapping intervals apart", () => {
    expect(mergeIntervals([span(0, 10), span(20, 30)])).toEqual([span(0, 10), span(20, 30)]);
  });

  it("collapses full overlap", () => {
    expect(mergeIntervals([span(0, 30), span(0, 30)])).toEqual([span(0, 30)]);
  });

  it("joins partial overlap", () => {
    expect(mergeIntervals([span(0, 20), span(10, 30)])).toEqual([span(0, 30)]);
  });

  it("swallows nested intervals", () => {
    expect(mergeIntervals([span(0, 60), span(10, 20), span(30, 40)])).toEqual([span(0, 60)]);
  });

  it("collapses a three-way overlap into one span", () => {
    expect(mergeIntervals([span(0, 25), span(10, 35), span(20, 45)])).toEqual([span(0, 45)]);
  });

  it("drops zero-length intervals", () => {
    expect(mergeIntervals([span(5, 5), span(10, 20)])).toEqual([span(10, 20)]);
  });

  it("sorts unordered input", () => {
    expect(mergeIntervals([span(20, 30), span(0, 10), span(9, 21)])).toEqual([span(0, 30)]);
  });
});

describe("clipping to a range", () => {
  it("clips an interval crossing the range boundary instead of dropping or keeping it whole", () => {
    expect(clipInterval(span(-10, 10), { start: at(0) })).toEqual(span(0, 10));
    expect(clipInterval(span(50, 70), { end: at(60) })).toEqual(span(50, 60));
    expect(clipInterval(span(-10, -5), { start: at(0) })).toBeNull();
  });

  it("counts only the in-range slice in totals", () => {
    expect(unionSeconds([span(-30, 30)], { start: at(0), end: at(60) })).toBe(30 * 60);
    expect(summedSeconds([span(-30, 30), span(45, 90)], { start: at(0), end: at(60) })).toBe(45 * 60);
  });
});

describe("unionSeconds vs summedSeconds", () => {
  it("union counts overlap once, sum counts it every time", () => {
    const parallel = [span(0, 60), span(0, 60)];
    expect(unionSeconds(parallel)).toBe(3_600);
    expect(summedSeconds(parallel)).toBe(7_200);
  });
});

describe("measureTime", () => {
  it("splits active time by agent concurrency and upholds both invariants", () => {
    // One hour at the machine. Agent A runs 0-40, agent B 20-50, agent C 25-35.
    const working = [span(0, 60)];
    const agents = [span(0, 40), span(20, 50), span(25, 35)];

    const measurement = measureTime(working, agents);

    expect(measurement.activeSeconds).toBe(3_600);
    // 0-20 one agent, 20-25 two, 25-35 three, 35-40 two, 40-50 one, 50-60 none.
    expect(measurement.concurrency).toEqual({
      t0Seconds: 10 * 60,
      t1Seconds: 30 * 60,
      t2Seconds: 10 * 60,
      t3PlusSeconds: 10 * 60,
      awaySeconds: 0,
    });
    const { t1Seconds, t2Seconds, t3PlusSeconds, t0Seconds, awaySeconds } = measurement.concurrency;
    expect(t0Seconds + t1Seconds + t2Seconds + t3PlusSeconds).toBe(measurement.activeSeconds);
    expect(t1Seconds + 2 * t2Seconds + 3 * t3PlusSeconds + awaySeconds).toBe(measurement.agentSeconds);
  });

  it("keeps agent time above active time under parallelism without inflating hours", () => {
    const measurement = measureTime([span(0, 60)], [span(0, 60), span(0, 60)]);

    expect(measurement.activeSeconds).toBe(3_600);
    expect(measurement.agentSeconds).toBe(7_200);
    expect(leverage(measurement)).toBe(2);
  });

  it("books an agent running while the person is away as away time, not active time", () => {
    // Active 0-30 only; the agent runs 0-90. The hour beyond presence is
    // consumption, never hours worked.
    const measurement = measureTime([span(0, 30)], [span(0, 90)]);

    expect(measurement.activeSeconds).toBe(30 * 60);
    expect(measurement.agentSeconds).toBe(90 * 60);
    expect(measurement.concurrency.t1Seconds).toBe(30 * 60);
    expect(measurement.concurrency.awaySeconds).toBe(60 * 60);
  });

  it("clips both working and agent intervals to the range", () => {
    const measurement = measureTime([span(-60, 30)], [span(-60, 15)], { start: at(0), end: at(60) });

    expect(measurement.activeSeconds).toBe(30 * 60);
    expect(measurement.agentSeconds).toBe(15 * 60);
    expect(measurement.concurrency.t1Seconds).toBe(15 * 60);
    expect(measurement.concurrency.t0Seconds).toBe(15 * 60);
  });

  it("measures zero for an empty range or zero-length intervals", () => {
    expect(measureTime([], []).activeSeconds).toBe(0);
    expect(measureTime([span(5, 5)], [span(3, 3)]).agentSeconds).toBe(0);
    expect(leverage({ activeSeconds: 0, agentSeconds: 100 })).toBeNull();
  });

  it("merges overlapping working intervals before bucketing (two devices at once)", () => {
    const measurement = measureTime([span(0, 40), span(20, 60)], [span(10, 30)]);

    expect(measurement.activeSeconds).toBe(3_600);
    expect(measurement.concurrency.t1Seconds).toBe(20 * 60);
    expect(measurement.concurrency.t0Seconds).toBe(40 * 60);
  });
});

describe("intersectIntervals", () => {
  it("keeps only time covered by both sets", () => {
    expect(intersectIntervals([span(0, 30)], [span(10, 40)])).toEqual([span(10, 30)]);
    expect(intersectIntervals([span(0, 10), span(20, 30)], [span(5, 25)])).toEqual([span(5, 10), span(20, 25)]);
    expect(intersectIntervals([span(0, 10)], [span(10, 20)])).toEqual([]);
  });
});

describe("bucket invariant under rounding", () => {
  it("keeps active time exactly equal to its buckets even with odd half-seconds", () => {
    // Boundaries deliberately land on half-seconds so every bucket rounds.
    const odd = (ms: number): number => ms;
    const measurement = measureTime(
      [{ start: odd(0), end: odd(10_500) }],
      [{ start: odd(1_500), end: odd(4_500) }, { start: odd(3_500), end: odd(7_500) }],
    );
    const { t0Seconds, t1Seconds, t2Seconds, t3PlusSeconds } = measurement.concurrency;
    expect(t0Seconds + t1Seconds + t2Seconds + t3PlusSeconds).toBe(measurement.activeSeconds);
  });
});

describe("leverage", () => {
  it("rounds to one decimal and reads 0 for fully manual work", () => {
    expect(leverage({ activeSeconds: 3_600, agentSeconds: 8_640 })).toBe(2.4);
    expect(leverage({ activeSeconds: 3_600, agentSeconds: 0 })).toBe(0);
  });
});
