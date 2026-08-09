//! Durable MV3 cadence. Chrome may evict a service worker between browser
//! events, so alarms, rather than in-memory intervals, own every wake-up that
//! must survive eviction.

import { reconnectBackoffMs } from "./outbox.js";

export const MIN_ALARM_MINUTES = 0.5;
export const TICK_ALARM_PERIOD_MINUTES = MIN_ALARM_MINUTES;
export const RULES_REFRESH_PERIOD_MINUTES = 5;

export const TICK_ALARM_NAME = "clock-in-tick";
export const RULES_REFRESH_ALARM_NAME = "clock-in-rules-refresh";
export const RECONNECT_ALARM_NAME = "clock-in-reconnect";
export const SPAN_ADVANCE_ALARM_NAME = "clock-in-span-advance";

/** Chrome 120+'s alarm floor, while retaining the existing 1s to 60s policy. */
export function reconnectDelayMinutes(attempt: number): number {
  return Math.max(MIN_ALARM_MINUTES, reconnectBackoffMs(attempt) / 60_000);
}
