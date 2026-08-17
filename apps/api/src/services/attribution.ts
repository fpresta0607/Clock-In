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
 * A directory named after a run rather than after a codebase. Tooling that
 * checks a repo out per run - a no-mistakes gate worktree lives at
 * `<hash>.git/worktrees/<ULID>`, and CI runners use similar shapes - leaves a
 * working directory whose last segment is an opaque id. A ULID (26 Crockford
 * base32 characters), a UUID, or a bare hex hash names no codebase to anyone.
 *
 * The ULID branch is uppercase-only, which the other two are not. Crockford is
 * canonically uppercase and every real gate worktree is
 * (`01M08C82C40W5Y5Q0X3BFGYNFT`), while lowercase 26-character run-together
 * words are ordinary codebase names - `backendservermanagementapp` uses none of
 * Crockford's excluded letters, and a case-insensitive branch swallowed it.
 */
const OPAQUE_SEGMENT =
  /^(?:[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{12,})$/;

/**
 * A working directory's codebase label: its last path segment, separators
 * unified so a Windows path and a POSIX one read the same. A name, never a
 * path - which is what lets every member of the workspace see which codebase an
 * agent worked while the path itself stays behind the `repoRoot` rule. Null
 * when nothing is left to name.
 *
 * An opaque id is *not* a name. A shift worked inside a per-run worktree used
 * to label itself with that run's id - "Claude Code @ 01M06FSGP392MH6VJNRX8T364A" -
 * and, because the identity key is the repo root, minted a fresh agent for
 * every run. Reading absence as absence is the rule the rest of the model
 * already follows: no codebase name, rather than a wrong one.
 */
export function repoLabel(path: string): string | null {
  const segments = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  const last = segments[segments.length - 1] ?? "";
  if (last === "" || OPAQUE_SEGMENT.test(last)) return null;
  return last.slice(0, 200);
}

/**
 * The repo root an agent identity is keyed on. A directory that names no
 * codebase cannot identify one either: keying on it mints a separate agent for
 * every run, which is how one operator's roster filled with a row per
 * no-mistakes gate worktree. Such a shift belongs in that operator's
 * unassigned bucket, and graduates in place if a commit ever names its
 * codebase - the same late-discovery path an un-probed session takes.
 */
export function identityRepoRoot(root: string | null): string | null {
  if (root === null) return null;
  return repoLabel(root) === null ? null : root;
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
