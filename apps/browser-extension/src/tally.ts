//! The unmatched-origin tally: focus-time per unmatched eTLD+1, kept in
//! extension storage and mirrored to the desktop through the native host for
//! the local needs-mapping view. Nothing in this module is ever uploaded;
//! the desktop's copy is a read-only passthrough.

/** Extension-storage shape: the current UTC week and its origin totals. */
export interface Tally {
  weekStart: number;
  entries: Record<string, number>;
  remainderMilliseconds: Record<string, number>;
}

export const TALLY_STORAGE_KEY = "unmatchedTally";

export function weekStartAt(now: number): number {
  const date = new Date(now);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

export function emptyTally(now: number = Date.now()): Tally {
  return { weekStart: weekStartAt(now), entries: {}, remainderMilliseconds: {} };
}

export function restoreTally(value: unknown, now: number = Date.now()): Tally {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return emptyTally(now);
  }
  const stored = value as Record<string, unknown>;
  const weekStart = weekStartAt(now);
  if (stored["weekStart"] !== weekStart || typeof stored["entries"] !== "object" || stored["entries"] === null || Array.isArray(stored["entries"])) {
    return emptyTally(now);
  }
  const entries: Record<string, number> = {};
  for (const [origin, seconds] of Object.entries(stored["entries"] as Record<string, unknown>)) {
    if (typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 0) {
      entries[origin] = seconds;
    }
  }
  const remainderMilliseconds: Record<string, number> = {};
  const storedRemainders = stored["remainderMilliseconds"];
  if (typeof storedRemainders === "object" && storedRemainders !== null && !Array.isArray(storedRemainders)) {
    for (const [origin, milliseconds] of Object.entries(storedRemainders as Record<string, unknown>)) {
      if (typeof milliseconds === "number" && Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds < 1_000) {
        remainderMilliseconds[origin] = milliseconds;
      }
    }
  }
  return { weekStart, entries, remainderMilliseconds };
}

export function rollTallyIntoCurrentWeek(tally: Tally, now: number = Date.now()): boolean {
  const weekStart = weekStartAt(now);
  if (tally.weekStart === weekStart) {
    return false;
  }
  tally.weekStart = weekStart;
  tally.entries = {};
  tally.remainderMilliseconds = {};
  return true;
}

// Common compound public suffixes, so `foo.bar.co.uk` tallies as `bar.co.uk`.
// This is an approximation of the public-suffix list, deliberately small; a
// missed compound suffix just tallies one label too deep, never leaks.
const COMPOUND_SUFFIXES = new Set([
  "ac.uk",
  "co.in",
  "co.jp",
  "co.nz",
  "co.uk",
  "co.za",
  "com.au",
  "com.br",
  "com.cn",
  "com.mx",
  "com.sg",
  "gov.uk",
  "net.au",
  "or.jp",
  "org.au",
  "org.uk",
]);

/**
 * Best-effort eTLD+1 for a hostname: the last two labels, or three under a
 * known compound suffix. Hosts without a dot (localhost, intranet names) and
 * IP literals stand on their own.
 */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const labels = host.split(".").filter((label) => label.length > 0);
  if (labels.length <= 2 || labels.every((label) => /^\d+$/.test(label))) {
    return labels.join(".");
  }
  const lastTwo = labels.slice(-2).join(".");
  if (COMPOUND_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

/** The tally origin for a URL, or null when the URL has no usable host. */
export function originFor(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const domain = registrableDomain(parsed.hostname);
  return domain.length === 0 ? null : domain;
}

/** Adds focused seconds to one unmatched origin. Mutates and returns the tally. */
export function addFocusSeconds(tally: Tally, origin: string, seconds: number, now: number = Date.now()): Tally {
  return addFocusMilliseconds(tally, origin, seconds * 1_000, now);
}

export function addFocusMilliseconds(tally: Tally, origin: string, milliseconds: number, now: number = Date.now()): Tally {
  rollTallyIntoCurrentWeek(tally, now);
  const wholeMilliseconds = Math.floor(milliseconds);
  if (wholeMilliseconds <= 0) {
    return tally;
  }
  const accumulated = (tally.remainderMilliseconds[origin] ?? 0) + wholeMilliseconds;
  const wholeSeconds = Math.floor(accumulated / 1_000);
  if (wholeSeconds > 0) {
    tally.entries[origin] = (tally.entries[origin] ?? 0) + wholeSeconds;
  }
  const remainder = accumulated % 1_000;
  if (remainder === 0) {
    delete tally.remainderMilliseconds[origin];
  } else {
    tally.remainderMilliseconds[origin] = remainder;
  }
  return tally;
}

/** The host-message shape: `[{ origin, seconds }]`, longest first. */
export function tallySnapshot(tally: Tally): Array<{ origin: string; seconds: number }> {
  return Object.entries(tally.entries)
    .map(([origin, seconds]) => ({ origin, seconds }))
    .filter((entry) => entry.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
}

/** User-clearable: wipes the local tally. */
export function clearTally(tally: Tally): void {
  tally.entries = {};
  tally.remainderMilliseconds = {};
}
