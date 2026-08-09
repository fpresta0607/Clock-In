import type { PathMappingKind } from "@clock-in/shared";

export interface PathMappingCandidate {
  pathPrefix: string;
  projectId: string;
}

export interface UrlRuleCandidate {
  id: string;
  kind: PathMappingKind;
  projectId: string;
}

/**
 * Resolves a browser span's matched rule to its project through the caller's
 * own live url-rule mappings. A deleted or foreign rule id resolves to null —
 * the span stays unattributed rather than erroring, so deleting a rule never
 * invalidates honest evidence already in flight.
 */
export function resolveProjectForRuleId(ruleId: string, mappings: readonly UrlRuleCandidate[]): string | null {
  const rule = mappings.find((mapping) => mapping.kind === "url_rule" && mapping.id === ruleId);
  return rule?.projectId ?? null;
}

/** Lowercases, unifies separators to "/", and strips trailing separators. */
export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * A prefix matches only on a path-segment boundary: `c:/dev/clock` matches
 * `c:/dev/clock` and `c:/dev/clock/src` but never `c:/dev/clock-in-extra`.
 */
function matchesBoundary(normalizedCwd: string, normalizedPrefix: string): boolean {
  if (normalizedPrefix.length === 0) return normalizedCwd.startsWith("/");
  return normalizedCwd === normalizedPrefix || normalizedCwd.startsWith(`${normalizedPrefix}/`);
}

/**
 * Resolves a working directory to a project by normalized longest-prefix match.
 * Equal-length ties are ambiguous and return null, unless every winner names
 * the same project.
 */
export function resolveProjectForCwd(cwd: string, mappings: readonly PathMappingCandidate[]): string | null {
  const normalizedCwd = normalizePath(cwd);
  let best: PathMappingCandidate[] = [];
  let bestLength = -1;
  for (const mapping of mappings) {
    const normalizedPrefix = normalizePath(mapping.pathPrefix);
    if (!matchesBoundary(normalizedCwd, normalizedPrefix)) continue;
    if (normalizedPrefix.length > bestLength) {
      bestLength = normalizedPrefix.length;
      best = [mapping];
    } else {
      best.push(mapping);
    }
  }
  if (best.length === 0) return null;
  const projectIds = new Set(best.map((mapping) => mapping.projectId));
  return projectIds.size === 1 ? best[0]!.projectId : null;
}
