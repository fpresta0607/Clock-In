//! URL-rule matching, evaluated entirely inside the browser process.
//!
//! Patterns are scheme-less `host[/path]` strings with a case-insensitive
//! host and at most one trailing glob: `github.com/acme/*`,
//! `app.linear.app/acme/*`, `*.figma.com/files/*`. A leading `*.` on the host
//! matches the bare host and every subdomain (Chrome match-pattern
//! semantics). A path without a glob is an exact match; a path ending in `/*`
//! is a boundary-aware prefix match. Longest pattern wins.

export interface UrlRule {
  id: string;
  pattern: string;
}

interface ParsedPattern {
  host: string;
  anySubdomain: boolean;
  /** Exact path, or the stem before a trailing `/*` glob. Null matches any path. */
  path: string | null;
  pathIsGlob: boolean;
}

const MAX_PATTERN_LENGTH = 500;

/** Parses a rule pattern; returns null for anything outside the grammar. */
export function parsePattern(pattern: string): ParsedPattern | null {
  const trimmed = pattern.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PATTERN_LENGTH) {
    return null;
  }
  // Patterns are scheme-less by contract; a scheme means a malformed rule.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  const rawHost = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const rawPath = slash === -1 ? null : trimmed.slice(slash + 1);

  let host = rawHost.toLowerCase();
  let anySubdomain = false;
  if (host.startsWith("*.")) {
    anySubdomain = true;
    host = host.slice(2);
  }
  if (host.length === 0 || host.includes("*")) {
    return null;
  }

  let path: string | null = null;
  let pathIsGlob = false;
  if (rawPath !== null && rawPath.length > 0) {
    if (rawPath.includes("*")) {
      // A single glob, and only as the trailing character.
      if (rawPath.indexOf("*") !== rawPath.length - 1) {
        return null;
      }
      path = rawPath.slice(0, -1);
      pathIsGlob = true;
      if (path.endsWith("/")) {
        path = path.slice(0, -1);
      }
    } else {
      path = rawPath;
    }
  }
  return { host, anySubdomain, path, pathIsGlob };
}

function hostMatches(hostname: string, pattern: ParsedPattern): boolean {
  if (pattern.anySubdomain) {
    return hostname === pattern.host || hostname.endsWith(`.${pattern.host}`);
  }
  return hostname === pattern.host;
}

function pathMatches(pathname: string, pattern: ParsedPattern): boolean {
  if (pattern.path === null) {
    return true;
  }
  const path = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (!pattern.pathIsGlob) {
    return path === pattern.path;
  }
  // `acme/*` covers `acme` itself and anything under the boundary.
  return path === pattern.path || path.startsWith(`${pattern.path}/`);
}

/**
 * Resolves a URL against the rule set and returns the winning rule id, or
 * null when nothing matches. Matching is longest-pattern-wins; ties go to
 * the earliest rule. Unparseable URLs and unparseable patterns never match,
 * so a broken rule set fails closed to silence.
 */
export function match(url: string, rules: readonly UrlRule[]): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname.length === 0) {
    return null;
  }

  let winner: { ruleId: string; length: number } | null = null;
  for (const rule of rules) {
    const pattern = parsePattern(rule.pattern);
    if (pattern === null) {
      continue;
    }
    if (!hostMatches(hostname, pattern) || !pathMatches(parsed.pathname, pattern)) {
      continue;
    }
    if (winner === null || rule.pattern.length > winner.length) {
      winner = { ruleId: rule.id, length: rule.pattern.length };
    }
  }
  return winner?.ruleId ?? null;
}
