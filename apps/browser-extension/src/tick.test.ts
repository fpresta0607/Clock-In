import { describe, expect, it } from "vitest";

import { tickCredit } from "./tick.js";

const TICK_MS = 5_000;
const T0 = Date.UTC(2026, 7, 9, 12, 0, 0);

describe("tickCredit", () => {
  it("credits the full elapsed time on a normal tick", () => {
    expect(tickCredit(T0 + 5_000, T0, TICK_MS)).toEqual({
      creditMs: 5_000,
      gapExceeded: false,
    });
  });

  it("clamps the credit to twice the tick interval after a long sleep", () => {
    const hour = 60 * 60 * 1000;
    expect(tickCredit(T0 + hour, T0, TICK_MS)).toEqual({
      creditMs: 10_000,
      gapExceeded: true,
    });
  });

  it("flags the gap as soon as the delta passes the clamp bound", () => {
    expect(tickCredit(T0 + 10_000, T0, TICK_MS).gapExceeded).toBe(false);
    expect(tickCredit(T0 + 10_001, T0, TICK_MS)).toEqual({
      creditMs: 10_000,
      gapExceeded: true,
    });
  });

  it("never credits negative time when the wall clock jumps backwards", () => {
    expect(tickCredit(T0 - 60_000, T0, TICK_MS)).toEqual({
      creditMs: 0,
      gapExceeded: false,
    });
  });
});
