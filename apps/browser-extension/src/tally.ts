//! The unmatched-origin tally: focus-time per unmatched eTLD+1, kept in
//! extension storage and mirrored to the desktop through the native host for
//! the local needs-mapping view. Nothing in this module is ever uploaded;
//! the desktop's copy is a read-only passthrough.

/** Extension-storage shape: origin -> accumulated focused seconds. */
export interface Tally {
  entries: Record<string, number>;
}

export const TALLY_STORAGE_KEY = "unmatchedTally";

export function emptyTally(): Tally {
  return { entries: {} };
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
export function addFocusSeconds(tally: Tally, origin: string, seconds: number): Tally {
  if (seconds <= 0) {
    return tally;
  }
  tally.entries[origin] = (tally.entries[origin] ?? 0) + seconds;
  return tally;
}

/** The host-message shape: `[{ origin, seconds }]`, longest first. */
export function tallySnapshot(tally: Tally): Array<{ origin: string; seconds: number }> {
  return Object.entries(tally.entries)
    .map(([origin, seconds]) => ({ origin, seconds }))
    .sort((a, b) => b.seconds - a.seconds);
}

/** User-clearable: wipes the local tally. */
export function clearTally(tally: Tally): void {
  tally.entries = {};
}
