export type PathMappingKind = "path_prefix" | "url_rule";

export interface PathMappingCandidate {
  id: string;
  kind: PathMappingKind;
  pathPrefix: string;
  projectId: string;
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
 * the same project. Only `path_prefix` mappings participate: a `url_rule`
 * pattern matches browser tabs, never an agent's working directory.
 */
export function resolveProjectForCwd(cwd: string, mappings: readonly PathMappingCandidate[]): string | null {
  const normalizedCwd = normalizePath(cwd);
  let best: PathMappingCandidate[] = [];
  let bestLength = -1;
  for (const mapping of mappings) {
    if (mapping.kind !== "path_prefix") continue;
    const normalizedPrefix = normalizePath(mapping.pathPrefix);
    if (!matchesBoundary(normalizedCwd, normalizedPrefix)) continue;
    if (normalizedPrefix.length > bestLength) {
      bestLength = normalizedPrefix.length;
      best = [mapping];
    } else if (normalizedPrefix.length === bestLength) {
      best.push(mapping);
    }
    // Shorter matches never fold into the winners, whatever the input order.
  }
  if (best.length === 0) return null;
  const projectIds = new Set(best.map((mapping) => mapping.projectId));
  return projectIds.size === 1 ? best[0]!.projectId : null;
}

/**
 * Resolves a browser span's matched rule to a project by its mapping id. The
 * extension already matched the URL locally, so the server only needs the
 * `url_rule` row whose id the span names — no pattern re-match, and a stale
 * rule id (mapping deleted) resolves to nothing rather than a guess.
 */
export function resolveProjectForRule(ruleId: string, mappings: readonly PathMappingCandidate[]): string | null {
  const match = mappings.find((mapping) => mapping.kind === "url_rule" && mapping.id === ruleId);
  return match?.projectId ?? null;
}
