import { describe, expect, it } from "vitest";

import {
  MIN_ALARM_MINUTES,
  reconnectDelayMinutes,
  RULES_REFRESH_PERIOD_MINUTES,
  TICK_ALARM_PERIOD_MINUTES,
} from "./schedule.js";

describe("reconnectDelayMinutes", () => {
  it("clamps sub-30 s backoff up to the chrome.alarms floor", () => {
    expect(reconnectDelayMinutes(0)).toBe(MIN_ALARM_MINUTES); // 1 s backoff
    expect(reconnectDelayMinutes(1)).toBe(MIN_ALARM_MINUTES); // 2 s
    expect(reconnectDelayMinutes(4)).toBe(MIN_ALARM_MINUTES); // 16 s
  });

  it("passes longer backoffs through and caps at one minute", () => {
    expect(reconnectDelayMinutes(5)).toBeCloseTo(32 / 60); // 32 s
    expect(reconnectDelayMinutes(6)).toBe(1); // 60 s
    expect(reconnectDelayMinutes(100)).toBe(1);
  });
});

describe("alarm periods", () => {
  it("never schedule below the chrome.alarms 30 s floor", () => {
    expect(TICK_ALARM_PERIOD_MINUTES).toBeGreaterThanOrEqual(MIN_ALARM_MINUTES);
    expect(RULES_REFRESH_PERIOD_MINUTES).toBeGreaterThanOrEqual(MIN_ALARM_MINUTES);
    expect(RULES_REFRESH_PERIOD_MINUTES).toBe(5);
  });
});
