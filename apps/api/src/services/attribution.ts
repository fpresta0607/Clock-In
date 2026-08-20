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
 * `<hash>.git/worktrees/<ULID>`, a treehouse worktree at `<slug>-<6hex>`, and
 * CI runners use similar shapes - leaves a working directory whose last
 * segment is an opaque id. A ULID (26 Crockford base32 characters), a UUID, a
 * bare hex hash, or a slug carrying a random hex suffix names no codebase to
 * anyone.
 *
 * The ULID branch is uppercase-only, which the other two are not. Crockford is
 * canonically uppercase and every real gate worktree is
 * (`01M08C82C40W5Y5Q0X3BFGYNFT`), while lowercase 26-character run-together
 * words are ordinary codebase names - `backendservermanagementapp` uses none of
 * Crockford's excluded letters, and a case-insensitive branch swallowed it.
 * The hex branch cannot be uppercase-only: git SHAs are lowercase, so that
 * would silently disable it while looking like a fix. Length does the work
 * there instead - only a full SHA-1 (40) or SHA-256 (64) hex string is
 * refused, so a shorter all-hex codebase name is never swallowed.
 *
 * The suffix branch - `dazzling-lamarr-0aacbd`, `upwork-automation-build-c164f2` -
 * is deliberately the narrowest of the four, because it is the only one whose
 * shape a real codebase could plausibly wear. It requires a non-empty slug, a
 * hyphen, then six or more lowercase hex characters carrying *both* a digit
 * and a letter. Each half of that rule keeps a real repository out of its
 * operator's bucket: without the digit the six-letter words that spell hex -
 * `decade`, `facade`, `beaded` - are swallowed, and without the letter every
 * dated or numbered directory is - `invoices-202601`, `release-20240115`,
 * `sprint-123456`. Roughly one random suffix in 16 is all-letters or
 * all-digits and slips through; that is the accepted ceiling, and it costs
 * nothing, because identity comes from the remote (`identityRepoKey`) and only
 * the label ever consults this. Needing this regex to hold the line means the
 * remote never reached the lane, which is the finding, not the fix.
 */
const OPAQUE_SEGMENT =
  /^(?:[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{40}|[0-9a-fA-F]{64}|.+-(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{6,})$/;

/**
 * A working directory's codebase label: its last path segment, separators
 * unified so a Windows path and a POSIX one read the same. A name, never a
 * path - which is what lets every member of the workspace see which codebase an
 * agent worked while the path itself stays behind the `repoRoot` rule. Null
 * when nothing is left to name.
 *
 * An opaque id is *not* a name. A shift worked inside a per-run worktree used
 * to label itself with that run's id - "Claude Code @ 01M06FSGP392MH6VJNRX8T364A" -
 * and, because the identity key was the repo root, minted a fresh agent for
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
 * The repo root that can stand in for a missing remote. A directory that names
 * no codebase cannot identify one either: keying on it mints a separate agent
 * for every run, which is how one operator's roster filled with a row per
 * no-mistakes gate worktree. Such a shift lands in that operator's unassigned
 * bucket instead - the same place an un-probed session goes - and stays there
 * until one of its own commits names a codebase, at which point that shift
 * alone moves onto that codebase's identity. The bucket itself is never keyed
 * on a codebase, because the shifts pooled in it worked several or none.
 */
export function identityRepoRoot(root: string | null): string | null {
  if (root === null) return null;
  return repoLabel(root) === null ? null : root;
}

/** The prefix that separates a path-keyed identity from a remote-keyed one. */
const pathKeyPrefix = "path:";

/** A URL scheme, which an scp-style remote (`git@host:owner/repo`) does not have. */
const remoteScheme = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The scp-style remote git accepts without a scheme: an optional user, a host,
 * a colon, then a path. The host is two characters or more, which is what keeps
 * a Windows path out on its own: `C:/dev/repo` and `C:devepo` are directories,
 * and a drive letter is one character. The path may be absolute -
 * `git@git.example.com:/srv/git/api.git` is a form `git clone` accepts and
 * self-hosted setups use - so nothing here refuses a leading separator.
 */
const scpLikeRemote = /^(?:[^@/\\:]+@)?([^/\\:]{2,}):(.+)$/;

/**
 * One git remote reduced to the identity it names: `github.com/owner/repo`.
 *
 * The same repository is spelled `git@github.com:owner/repo.git`,
 * `https://github.com/owner/repo.git`, `https://github.com/owner/repo` and
 * `ssh://git@github.com/owner/repo` by four people on one team, so the host,
 * the `.git` suffix, the transport, any credentials in the URL and any port
 * are all stripped, and what is left is lowercased. Case folds because GitHub
 * treats `Owner/Repo` and `owner/repo` as one repository and two clones can
 * legitimately have been typed either way; a host that really did distinguish
 * them would be the first anyone has met.
 *
 * Null when the remote names no host - a `file://` URL, a bare path, or a UNC
 * share. Those are directories, and a directory identifies a checkout rather
 * than a repository, so they fall through to the path lane in
 * `identityRepoKey` rather than pretending to be a shared identity.
 */
export function normalizeRemote(remote: string): string | null {
  const trimmed = remote.trim();
  if (trimmed === "") return null;
  let authority: string;
  let path: string;
  const scheme = remoteScheme.exec(trimmed);
  if (scheme !== null) {
    if (scheme[0].toLowerCase() === "file://") return null;
    const rest = trimmed.slice(scheme[0].length);
    const separator = rest.indexOf("/");
    if (separator <= 0) return null;
    authority = rest.slice(0, separator);
    path = rest.slice(separator + 1);
  } else {
    const scp = scpLikeRemote.exec(trimmed);
    if (scp === null) return null;
    authority = scp[1]!;
    path = scp[2]!;
  }
  // Credentials and transport are not identity: a token embedded in the URL
  // and a non-default ssh port both name the same repository as the plain form.
  const host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d+$/, "").toLowerCase();
  if (host === "") return null;
  const owned = path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (owned === "") return null;
  return `${host}/${owned}`;
}

/**
 * The value an agent identity is keyed on, in preference order.
 *
 * 1. **The normalized remote.** The only identifier that is the same in every
 *    worktree, in a second checkout of the same repository under another
 *    directory name, and on another machine - which is the whole point. Keying
 *    on the repo root instead is what put five `precisiondocs` rows on one
 *    operator's roster: every treehouse worktree is its own path, so every
 *    worktree minted its own agent, and because the name is composed from the
 *    last segment all five rendered the same string. Keyed by path, displayed
 *    by basename.
 * 2. **The repo root, as `path:<root>`.** A repository with no remote is
 *    legitimate and must not collapse into one bucket with every other
 *    local-only repository, so its own directory identifies it - the best
 *    available answer, and the same answer identity gave before remotes were
 *    read. Its own lane so it can never collide with a remote, and the root is
 *    carried through verbatim: this lane must reproduce exactly the identity
 *    the repo-root key already gave, or `0016_agent_identity_by_remote`'s
 *    backfill would fold two live rows onto one key and abort on the unique
 *    index it then builds. Git emits one spelling of a root
 *    (`rev-parse --show-toplevel`), so there is nothing to normalize away.
 * 3. **Nothing.** Work that happened outside any repository at all, which is
 *    the honest unassigned case: the operator's bucket, shared by every such
 *    shift rather than minting a row each.
 *
 * A working directory that names only a run reaches lane 2 as no name at all,
 * so it falls to lane 3 - but only when the remote is missing too. A gate
 * worktree of a real repository has a remote, and that remote is what it is.
 */
export function identityRepoKey(repoRoot: string | null, repoRemote: string | null): string | null {
  const remote = repoRemote === null ? null : normalizeRemote(repoRemote);
  if (remote !== null) return remote;
  const root = identityRepoRoot(repoRoot);
  return root === null ? null : `${pathKeyPrefix}${root}`;
}

/**
 * The codebase name an identity key carries: the repository's own name from a
 * remote key, and the directory's last segment from a path key. The fallback
 * for a row whose repo root names only a run - a worktree of a repository the
 * remote did identify - so the roster still says which codebase, rather than
 * reading "unassigned" about work whose repository is known.
 */
export function repoKeyLabel(repoKey: string): string | null {
  if (repoKey.startsWith(pathKeyPrefix)) return repoLabel(repoKey.slice(pathKeyPrefix.length));
  const segments = repoKey.split("/");
  const last = segments[segments.length - 1] ?? "";
  return last === "" ? null : last.slice(0, 200);
}

/**
 * The codebase name an agent row renders, wherever it renders: the repository
 * the identity is keyed on, and the directory only when there is no key at all.
 *
 * Reading the directory first is how one worktree's folder name becomes the
 * displayed codebase for a whole repository - every shift from every worktree
 * of `github.com/acme/clock-in` reading "@ fix-login". For a path key the two
 * answer the same string; for a remote key this is the repository's own name,
 * lowercased, and that trade is deliberate: one canonical name across every
 * worktree and every checkout beats preserving one directory's capitalisation.
 *
 * One definition on purpose. The roster view, the default name the API mints,
 * and the name scripts/repair-agent-identity-by-remote.mjs writes onto a
 * survivor all read this, so a repaired roster reads exactly like a freshly
 * minted one and no copy can drift from the others.
 */
export function agentCodebaseLabel(repoRoot: string | null, repoKey: string | null): string | null {
  return (repoKey === null ? null : repoKeyLabel(repoKey))
    ?? (repoRoot === null ? null : repoLabel(repoRoot));
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
