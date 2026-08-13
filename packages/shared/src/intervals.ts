/**
 * The time model, in one place.
 *
 * Three measurements, deliberately distinct:
 *
 * - **Active time** — the union of the intervals a person was actually working,
 *   overlaps collapsed. It can never exceed wall clock, which is what makes it
 *   the fair leaderboard number.
 * - **Agent time** — the sum of per-agent runtime intervals. Two agents running
 *   an hour in parallel is 2h of agent time inside 1h of active time. A
 *   consumption and leverage number, never an effort number.
 * - **Concurrency** — active time partitioned by how many agents ran during
 *   each slice (t0 unassisted, t1, t2, t3+), plus the agent runtime that fell
 *   entirely outside active time (agents grinding while the person was away),
 *   which feeds agent time but never active time.
 *
 * Both surfaces and the API compute through this module so the invariants
 * (`active = t0+t1+t2+t3plus`, `agent = Σ n·tn + away`) hold everywhere.
 */

export type Interval = {
  /** Milliseconds since epoch, inclusive start. */
  start: number;
  /** Milliseconds since epoch, exclusive end. */
  end: number;
};

/** Clips an interval to a range; null when nothing overlaps. */
export function clipInterval(interval: Interval, range: Partial<Interval>): Interval | null {
  const start = Math.max(interval.start, range.start ?? -Infinity);
  const end = Math.min(interval.end, range.end ?? Infinity);
  return start < end ? { start, end } : null;
}

/** Merges overlapping or touching intervals into a sorted disjoint set. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** The overlap of two interval sets: time covered by both. Inputs need not be disjoint. */
export function intersectIntervals(left: readonly Interval[], right: readonly Interval[]): Interval[] {
  const a = mergeIntervals(left);
  const b = mergeIntervals(right);
  const overlaps: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i]!.start, b[j]!.start);
    const end = Math.min(a[i]!.end, b[j]!.end);
    if (start < end) overlaps.push({ start, end });
    if (a[i]!.end < b[j]!.end) i++;
    else j++;
  }
  return overlaps;
}

/** Total seconds covered by a set of intervals, overlaps counted once. */
export function unionSeconds(intervals: readonly Interval[], range: Partial<Interval> = {}): number {
  const clipped = intervals
    .map((interval) => clipInterval(interval, range))
    .filter((interval): interval is Interval => interval !== null);
  return Math.round(mergeIntervals(clipped).reduce((sum, interval) => sum + (interval.end - interval.start), 0) / 1_000);
}

/** Plain summed seconds, overlaps counted every time they occur. */
export function summedSeconds(intervals: readonly Interval[], range: Partial<Interval> = {}): number {
  return Math.round(
    intervals
      .map((interval) => clipInterval(interval, range))
      .filter((interval): interval is Interval => interval !== null)
      .reduce((sum, interval) => sum + (interval.end - interval.start), 0) / 1_000,
  );
}

export type ConcurrencyBreakdown = {
  /** Active seconds with no agent running. */
  t0Seconds: number;
  /** Active seconds with exactly one agent running. */
  t1Seconds: number;
  /** Active seconds with exactly two agents running. */
  t2Seconds: number;
  /** Active seconds with three or more agents running. */
  t3PlusSeconds: number;
  /** Agent runtime that fell entirely outside active time — agents working while the person was away. */
  awaySeconds: number;
};

export type TimeMeasurement = {
  /** Union of the person's working intervals, clipped to the range. */
  activeSeconds: number;
  /** Sum of agent runtime intervals, clipped to the range. May exceed activeSeconds. */
  agentSeconds: number;
  concurrency: ConcurrencyBreakdown;
};

/**
 * Sweep-line over one person's working intervals and agent-runtime intervals.
 *
 * Invariants, asserted here because a silent drift would quietly misstate
 * someone's work:
 *   activeSeconds = t0 + t1 + t2 + t3plus
 *   agentSeconds  = Σ (n × tn measured exactly) + awaySeconds
 * The histogram buckets round independently, so the assertion tolerates only
 * sub-second rounding.
 */
export function measureTime(
  workingIntervals: readonly Interval[],
  agentIntervals: readonly Interval[],
  range: Partial<Interval> = {},
): TimeMeasurement {
  const active = mergeIntervals(
    workingIntervals
      .map((interval) => clipInterval(interval, range))
      .filter((interval): interval is Interval => interval !== null),
  );
  const agents = agentIntervals
    .map((interval) => clipInterval(interval, range))
    .filter((interval): interval is Interval => interval !== null);

  // Every boundary where agent concurrency can change, plus the active edges.
  const cuts = [...new Set([
    ...active.flatMap((interval) => [interval.start, interval.end]),
    ...agents.flatMap((interval) => [interval.start, interval.end]),
  ])].sort((a, b) => a - b);

  const buckets = { t0: 0, t1: 0, t2: 0, t3plus: 0 };
  let coveredAgentMs = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const start = cuts[i]!;
    const end = cuts[i + 1]!;
    const isActive = active.some((interval) => interval.start <= start && end <= interval.end);
    if (!isActive) continue;
    const running = agents.filter((interval) => interval.start <= start && end <= interval.end).length;
    const ms = end - start;
    if (running === 0) buckets.t0 += ms;
    else if (running === 1) buckets.t1 += ms;
    else if (running === 2) buckets.t2 += ms;
    else buckets.t3plus += ms;
    coveredAgentMs += running * ms;
  }

  const activeSeconds = Math.round(active.reduce((sum, interval) => sum + (interval.end - interval.start), 0) / 1_000);
  const agentMs = agents.reduce((sum, interval) => sum + (interval.end - interval.start), 0);
  const concurrency: ConcurrencyBreakdown = {
    t0Seconds: Math.round(buckets.t0 / 1_000),
    t1Seconds: Math.round(buckets.t1 / 1_000),
    t2Seconds: Math.round(buckets.t2 / 1_000),
    t3PlusSeconds: Math.round(buckets.t3plus / 1_000),
    awaySeconds: Math.round(Math.max(0, agentMs - coveredAgentMs) / 1_000),
  };

  // The invariant, restored rather than asserted. Each of the four buckets
  // rounds once and activeSeconds rounds once, so the drift is at most a
  // couple of seconds - and the largest bucket absorbing it keeps
  // `active = t0+t1+t2+t3plus` exactly true for every caller. Throwing here
  // would take a whole leaderboard down over a rounding remainder.
  const bucketKeys = ["t0Seconds", "t1Seconds", "t2Seconds", "t3PlusSeconds"] as const;
  const bucketSum = bucketKeys.reduce((sum, key) => sum + concurrency[key], 0);
  const drift = activeSeconds - bucketSum;
  if (drift !== 0) {
    const largest = [...bucketKeys].sort((a, b) => concurrency[b] - concurrency[a])[0];
    if (largest !== undefined && concurrency[largest] + drift >= 0) concurrency[largest] += drift;
  }

  return { activeSeconds, agentSeconds: Math.round(agentMs / 1_000), concurrency };
}

/** `agent time ÷ active time`, rounded to one decimal; null when there is no active time. */
export function leverage(measurement: Pick<TimeMeasurement, "activeSeconds" | "agentSeconds">): number | null {
  if (measurement.activeSeconds === 0) return null;
  return Math.round((measurement.agentSeconds / measurement.activeSeconds) * 10) / 10;
}
