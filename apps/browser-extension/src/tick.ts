//! Per-tick wall-clock accounting for the service worker's steady timer.
//!
//! MV3 timers and the wall clock are unreliable across laptop sleep: a tick
//! scheduled for five seconds can fire hours late. Crediting the raw delta
//! would hand those hours to whatever origin and focus state was current
//! before the sleep, so the credit is clamped to twice the tick interval and
//! any overrun is flagged so the caller re-validates idle/focus before
//! trusting the current state.

export interface TickCredit {
  /** Milliseconds creditable this tick: the delta clamped to [0, 2x tick]. */
  creditMs: number;
  /** True when the raw delta passed the clamp bound (sleep or eviction). */
  gapExceeded: boolean;
}

export function tickCredit(now: number, lastTickAt: number, tickMs: number): TickCredit {
  const delta = now - lastTickAt;
  const bound = 2 * tickMs;
  return {
    creditMs: Math.min(Math.max(delta, 0), bound),
    gapExceeded: delta > bound,
  };
}
