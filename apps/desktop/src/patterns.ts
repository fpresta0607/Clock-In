// Turns a tallied origin into the URL rule a "Yes" answer creates. Pure:
// the suggestion UI asks the question, this module decides what the rule
// looks like. Whole-site by default; the hosts known to span many projects
// get the narrower question instead ("Is github.com/acme work?"), because a
// whole-site github.com rule would attribute every repository to one
// project.

/// Hosts where one site covers many unrelated projects, so the suggestion
/// asks for the organization (or user) path segment rather than ruling the
/// whole host.
export const MULTI_PROJECT_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "linear.app",
]);

export type RulePlan =
  | { readonly kind: "whole-site"; readonly origin: string; readonly pattern: string }
  | { readonly kind: "path-narrowed"; readonly origin: string };

/// Normalizes a tallied origin to the lowercase host rules match against.
/// Empty or malformed input returns null; the suggestion is skipped rather
/// than guessed at.
export const normalizeOrigin = (origin: string): string | null => {
  const cleaned = origin.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
  if (cleaned === "" || cleaned.includes("/") || /\s/.test(cleaned)) return null;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(cleaned)
    ? cleaned
    : null;
};

/**
 * The plan for one suggestion answer. Whole-site patterns lead with `*.`,
 * which matches the bare host and every subdomain (Chrome match-pattern
 * semantics, mirrored by the extension's matcher).
 */
export const planRule = (origin: string): RulePlan | null => {
  const host = normalizeOrigin(origin);
  if (host === null) return null;
  if (MULTI_PROJECT_HOSTS.has(host)) return { kind: "path-narrowed", origin: host };
  return { kind: "whole-site", origin: host, pattern: `*.${host}` };
};

/**
 * The path-narrowed answer for a multi-project host: the organization or
 * user segment the user typed, as a `host/segment/*` rule. Returns null for
 * anything that is not a single path segment; the UI asks again rather than
 * saving a pattern the contract would reject.
 */
export const narrowedPattern = (origin: string, segment: string): string | null => {
  const host = normalizeOrigin(origin);
  if (host === null || !MULTI_PROJECT_HOSTS.has(host)) return null;
  const cleaned = segment.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(cleaned)) return null;
  return `${host}/${cleaned}/*`;
};
