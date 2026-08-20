//! Read-only git evidence for shift commits: discovering a repo, listing the
//! commits authored during a shift's window, and later checking whether they
//! made it into the main line.
//!
//! Every command here reads what is already on disk. Nothing fetches, pulls,
//! or writes — a shift's evidence must never depend on network access, and a
//! read-only tool must never mutate the repo it is reporting on.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// git can hang on a slow filesystem or a huge pack; a shift's capture must
/// never block the uploader indefinitely over it.
const GIT_TIMEOUT: Duration = Duration::from_secs(10);

/// Runs one read-only git command, discarding stderr (never worth surfacing
/// to a user) and returning trimmed stdout on success. Any failure — git not
/// installed, not a repo, a bad ref, a timeout — collapses to `None`; the
/// caller always has an honest "unknown" to fall back to.
async fn run_git(cwd: &Path, args: &[&str]) -> Option<String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = tokio::time::timeout(GIT_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|text| text.trim().to_string())
}

/// Where a shift's working directory actually lives, and which branch (if
/// any — a detached HEAD carries none) was checked out there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoLocation {
    pub root: PathBuf,
    pub branch: Option<String>,
}

/// Resolves `cwd` to the repo it sits in, or `None` when it is not inside a
/// git working tree at all — a non-repo cwd records nothing, not an error.
pub async fn discover_repo(cwd: &Path) -> Option<RepoLocation> {
    let root = run_git(cwd, &["rev-parse", "--show-toplevel"]).await?;
    let root = PathBuf::from(root);
    let head = run_git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    let branch = if head == "HEAD" { None } else { Some(head) };
    Some(RepoLocation { root, branch })
}

/// The commit `HEAD` pointed at when a shift opened. Recorded by the hook at
/// the moment the `Started` line is written, so the shift's capture can be
/// bounded to what appeared afterward instead of reading HEAD minutes later.
///
/// Synchronous (`std::process::Command`) on purpose: the hook is a synchronous
/// binary, and `git rev-parse HEAD` takes no locks and reads two files, so it
/// cannot slow down or block the agent CLI that invoked the hook.
pub fn head_sha(cwd: &Path) -> Option<String> {
    let mut command = std::process::Command::new("git");
    command
        .args(["rev-parse", "HEAD"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|text| text.trim().to_string())
}

/// The repository a shift's working directory sits in, or `None` when it is
/// not inside a git working tree at all - a non-repo cwd names no codebase,
/// which is honest rather than an error.
///
/// Synchronous for the same reason `head_sha` is, and not `discover_repo`
/// reused: that one is async over `tokio::process::Command` and the hook is a
/// synchronous binary with no runtime, and it must never block the agent CLI
/// that invoked it. `git rev-parse --show-toplevel` takes no locks and reads
/// the directory walk it would have done anyway.
pub fn repo_root(cwd: &Path) -> Option<PathBuf> {
    probe_repo_root("git", cwd)
}

fn probe_repo_root(git: &str, cwd: &Path) -> Option<PathBuf> {
    let mut command = std::process::Command::new(git);
    command
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let root = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if root.is_empty() {
        return None;
    }
    Some(PathBuf::from(root))
}

/// The repository's `origin` remote, or `None` when it has none - a
/// repository nobody pushed anywhere is legitimate, and the server keys such
/// an agent on its root instead.
///
/// This is what makes the agent roster one row per repository rather than one
/// per directory: every worktree is its own path and every second checkout is
/// another, but they all report the same remote, on this machine and on the
/// next one. Sent with any embedded credentials removed and otherwise
/// unchanged; the server normalizes the spellings (`normalizeRemote` in
/// apps/api/src/services/attribution.ts), because the same repository is
/// `git@github.com:owner/repo.git` here and `https://github.com/owner/repo` on
/// a teammate's machine.
///
/// `config --get` rather than `remote get-url`: the configured value, with no
/// `insteadOf` rewriting applied, is the same string in both checkouts of one
/// repository on one machine. `--local` because a bare `config --get` is the
/// one git subcommand that does not fail outside a repository - it falls
/// through to global and system config, so a working directory that is not a
/// checkout at all would report whatever `remote.origin.url` the user happens
/// to have set globally, and `identityRepoKey` would attribute that shift to a
/// repository it never touched. `--local` reads the repository's own config
/// and nothing else, which a linked worktree shares with its parent, so every
/// worktree of one repository still reports the same origin. Synchronous and
/// non-blocking for the same reasons `repo_root` is.
pub fn repo_remote(cwd: &Path) -> Option<String> {
    probe_repo_remote("git", cwd, &[])
}

/// A remote URL with its `userinfo@` component removed, and every other
/// spelling left exactly as configured.
///
/// A token-authenticated clone stores its credential in the remote -
/// `https://x-access-token:TOKEN@github.com/owner/repo.git` is what CI and
/// container tooling write - so sending the configured value verbatim would
/// put a live token on the wire on every agent session start. The server
/// discards `userinfo` anyway, but a secret discarded after transmission was
/// still transmitted, so it never leaves the machine that owns it.
///
/// Identity does not move: `normalizeRemote` strips the same component, so two
/// checkouts of one repository still key on the same value whether or not
/// either had a token embedded. The scp-style form `git@host:owner/repo` is
/// deliberately untouched - that `git` is a transport user name rather than a
/// credential, and it is what makes the form parseable at all.
fn without_embedded_credentials(remote: &str) -> String {
    let Some(scheme) = remote.find("://") else {
        return remote.to_string();
    };
    let authority_start = scheme + 3;
    let authority_end = remote[authority_start..]
        .find('/')
        .map_or(remote.len(), |offset| authority_start + offset);
    let authority = &remote[authority_start..authority_end];
    match authority.rfind('@') {
        None => remote.to_string(),
        Some(at) => format!(
            "{}{}{}",
            &remote[..authority_start],
            &authority[at + 1..],
            &remote[authority_end..]
        ),
    }
}

fn probe_repo_remote(git: &str, cwd: &Path, env: &[(&str, &OsStr)]) -> Option<String> {
    let mut command = std::process::Command::new(git);
    command
        .args(["config", "--local", "--get", "remote.origin.url"])
        .current_dir(cwd)
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let configured = String::from_utf8(output.stdout).ok()?.trim().to_string();
    let remote = without_embedded_credentials(&configured);
    // The contract caps it at 1000 characters and rejects an empty string, so
    // an absurd value is dropped here rather than 400ing the whole batch.
    if remote.is_empty() || remote.chars().count() > 1_000 {
        return None;
    }
    Some(remote)
}

/// One commit authored during a shift, ready to become a `shift_commits` row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitEvidence {
    pub sha: String,
    pub authored_at: String,
    pub subject: String,
}

/// The identity a commit made on this machine carries. A commit committed by
/// anyone else reached the repo through a `git pull`, and a teammate's work is
/// not this shift's work. `None` when the repo resolves no identity at all,
/// which is the one case where filtering on it would drop everything instead
/// of nothing.
async fn local_committer(root: &Path) -> Option<String> {
    let email = run_git(root, &["config", "--get", "user.email"]).await?;
    if email.is_empty() {
        None
    } else {
        Some(email)
    }
}

/// Lists the commits this shift added to `HEAD`: the `start_head..HEAD` range
/// from the sha recorded when the shift opened, committed by this machine's
/// own git identity, and authored inside `[started_at, ended_at]` (unix
/// seconds, inclusive).
///
/// All three bounds are here because a mid-shift `git pull` used to be
/// credited to the agent. The range drops history that was already reachable
/// when the shift opened, the committer drops the teammates' commits the pull
/// brought in, and the author date is the guard for anything whose dates were
/// rewritten. A commit the human made by hand during the shift is still the
/// shift's — the window is what a shift is, and this has always been so.
pub async fn commits_in_window(
    root: &Path,
    start_head: &str,
    started_at: u64,
    ended_at: u64,
) -> Vec<CommitEvidence> {
    let range = format!("{start_head}..HEAD");
    let committer = local_committer(root)
        .await
        .map(|email| format!("--committer={email}"));
    let mut args = vec!["log", &range, "--pretty=format:%H%x1f%aI%x1f%s"];
    if let Some(argument) = committer.as_deref() {
        // An address is not a regular expression; a '+' in one would be.
        args.push("--fixed-strings");
        args.push(argument);
    }
    let Some(output) = run_git(root, &args).await else {
        return Vec::new();
    };
    output
        .lines()
        .filter_map(|line| parse_log_line(line, started_at, ended_at))
        .collect()
}

/// The check constraint's bound on a captured subject; a longer one is
/// truncated rather than rejected, so an unusually long message still records
/// something.
const MAX_SUBJECT_CHARS: usize = 500;

fn parse_log_line(line: &str, started_at: u64, ended_at: u64) -> Option<CommitEvidence> {
    let mut fields = line.splitn(3, '\u{1f}');
    let sha = fields.next()?.to_string();
    let authored_at_raw = fields.next()?;
    let subject = fields.next().unwrap_or_default();
    let authored_unix = crate::monitor::parse_iso8601(authored_at_raw)?;
    if authored_unix < started_at || authored_unix > ended_at {
        return None;
    }
    Some(CommitEvidence {
        sha,
        authored_at: crate::monitor::iso8601(authored_unix),
        subject: truncate_subject(subject),
    })
}

fn truncate_subject(subject: &str) -> String {
    if subject.chars().count() <= MAX_SUBJECT_CHARS {
        subject.to_string()
    } else {
        subject.chars().take(MAX_SUBJECT_CHARS).collect()
    }
}

/// The remote-tracking branch a merge is judged against: `origin/HEAD` if the
/// clone has one set, else the first of `origin/main` / `origin/master` that
/// exists locally. `None` when there is no remote at all — verification then
/// falls back to local-ref existence only (a "no remote" repo stays pending
/// rather than being judged merged or reverted against nothing).
async fn default_ref(root: &Path) -> Option<String> {
    if let Some(target) = run_git(
        root,
        &["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
    )
    .await
    {
        if !target.is_empty() {
            return Some(target);
        }
    }
    for candidate in ["origin/main", "origin/master"] {
        if run_git(root, &["rev-parse", "--verify", "-q", candidate])
            .await
            .is_some()
        {
            return Some(candidate.to_string());
        }
    }
    None
}

/// Where a captured commit stands relative to the project's main line.
/// `Pending` is the honest default: not yet decided, not a failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verification {
    Merged,
    Reverted,
    Orphaned,
    Pending,
}

/// Whether the default ref already carries this commit's change under some
/// other sha — what a squash merge or a rebase merge leaves behind. `git
/// cherry` compares patch ids across the two sides and marks a commit `-`
/// when an equivalent change is already upstream.
async fn landed_as_a_different_commit(root: &Path, sha: &str, default: &str) -> bool {
    let Some(output) = run_git(root, &["cherry", default, sha]).await else {
        return false;
    };
    output
        .lines()
        .any(|line| line.strip_prefix("- ").map(str::trim) == Some(sha))
}

/// Whether a commit on the default ref names this sha in its message — the
/// `(cherry picked from commit <sha>)` trailer, and the body a squash merge
/// carries on hosts that list the commits they squashed.
async fn referenced_on_the_default_ref(
    root: &Path,
    sha: &str,
    default: &str,
    since_arg: &str,
) -> bool {
    let grep_arg = format!("--grep={sha}");
    match run_git(
        root,
        &[
            "log",
            default,
            since_arg,
            &grep_arg,
            "--fixed-strings",
            "--pretty=format:%H",
        ],
    )
    .await
    {
        Some(output) => !output.is_empty(),
        None => false,
    }
}

/// Checks a captured commit against the repo on disk: explicitly reverted on
/// the default ref, merged into it, no longer reachable from any local ref
/// (orphaned), or still undecided (pending). Every ref walked here already
/// exists locally — nothing is fetched.
///
/// Reverted is checked before merged: a revert commit does not remove the
/// original from history, so a reverted commit is still its own ancestor —
/// checking merged first would report work that did not hold as if it did.
///
/// Merged is not just ancestry. A squash merge and a rebase merge both put a
/// *different* sha on the default branch, so the captured commit is never an
/// ancestor of it; before this checked patch ids and message references, every
/// commit from a squash-merging team ended up terminally `orphaned` the moment
/// the merged branch was deleted, and the paystub read 0% held for work that
/// all held.
pub async fn verify(root: &Path, sha: &str, authored_at: &str) -> Verification {
    if let Some(default) = default_ref(root).await {
        let since_arg = match crate::monitor::parse_iso8601(authored_at) {
            Some(unix) => format!("--since=@{unix}"),
            None => format!("--since={authored_at}"),
        };
        let grep_arg = format!("--grep=This reverts commit {sha}");
        if let Some(output) = run_git(
            root,
            &["log", &default, &since_arg, &grep_arg, "--pretty=format:%H"],
        )
        .await
        {
            if !output.is_empty() {
                return Verification::Reverted;
            }
        }
        if run_git(root, &["merge-base", "--is-ancestor", sha, &default])
            .await
            .is_some()
            || landed_as_a_different_commit(root, sha, &default).await
            || referenced_on_the_default_ref(root, sha, &default, &since_arg).await
        {
            return Verification::Merged;
        }
    }
    if run_git(root, &["cat-file", "-e", sha]).await.is_none() {
        return Verification::Orphaned;
    }
    match run_git(root, &["for-each-ref", &format!("--contains={sha}")]).await {
        Some(output) if !output.is_empty() => Verification::Pending,
        _ => Verification::Orphaned,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "clock-in-git-evidence-{name}-{}-{}",
            std::process::id(),
            unique_suffix()
        ));
        std::fs::create_dir_all(&dir).expect("scratch dir creates");
        dir
    }

    fn unique_suffix() -> u64 {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    async fn run(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .expect("git runs");
        assert!(status.success(), "git {args:?} failed in {cwd:?}");
    }

    async fn init_repo(dir: &Path) {
        run(dir, &["init", "--quiet", "--initial-branch=main"]).await;
        run(dir, &["config", "user.email", "shift@example.test"]).await;
        run(dir, &["config", "user.name", "Shift Test"]).await;
        run(dir, &["config", "commit.gpgsign", "false"]).await;
    }

    /// A bare repo to stand in for a remote: local pushes and fetches against
    /// it never touch the network, and unlike a normal repo it accepts a push
    /// to whichever branch is currently "checked out".
    async fn init_bare_origin(dir: &Path) {
        std::fs::create_dir_all(dir).expect("origin dir creates");
        run(dir, &["init", "--quiet", "--bare", "--initial-branch=main"]).await;
    }

    fn head(dir: &Path) -> String {
        head_sha(dir).expect("HEAD resolves")
    }

    /// Pushes `main` to `origin` and immediately fetches it back, so `work`'s
    /// local `refs/remotes/origin/main` reflects what was just pushed. The
    /// fetch is test setup only — product code never fetches.
    async fn push_and_fetch(work: &Path) {
        run(work, &["push", "origin", "main"]).await;
        run(work, &["fetch", "origin"]).await;
    }

    /// Commits with an explicit author/committer date, so window-filtering
    /// tests control exactly when each commit "happened" instead of racing
    /// the wall clock.
    /// Commits whatever is already staged, with an explicit author/committer
    /// date so window-filtering tests control when each commit "happened".
    async fn commit_with_message(dir: &Path, message: &str, unix_time: u64) {
        let date = crate::monitor::iso8601(unix_time);
        let status = Command::new("git")
            .args(["commit", "--quiet", "-m", message])
            .current_dir(dir)
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .expect("git commit runs");
        assert!(status.success(), "git commit failed in {dir:?}");
    }

    async fn commit_at(dir: &Path, file_name: &str, message: &str, unix_time: u64) {
        std::fs::write(dir.join(file_name), message).expect("scratch file writes");
        run(dir, &["add", "-A"]).await;
        commit_with_message(dir, message, unix_time).await;
    }

    #[tokio::test]
    async fn repo_root_names_the_repository_a_working_directory_sits_in() {
        let dir = temp_dir("repo-root");
        init_repo(&dir).await;
        commit_at(&dir, "a.txt", "first", 1_700_000_000).await;
        let nested = dir.join("apps").join("web");
        std::fs::create_dir_all(&nested).expect("nested dir creates");

        // A directory deep inside the tree still names the repository, which
        // is what keeps one codebase from fanning into one agent per folder.
        let from_root = repo_root(&dir).expect("the repo root resolves");
        let from_nested = repo_root(&nested).expect("a nested cwd resolves the same root");
        assert_eq!(
            std::fs::canonicalize(&from_nested).expect("canonical"),
            std::fs::canonicalize(&from_root).expect("canonical")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn repo_root_of_a_non_repo_is_an_honest_none() {
        let dir = temp_dir("repo-root-plain");

        // Not an error: a shift outside a repository names no codebase and
        // lands in its operator's unassigned bucket.
        assert_eq!(repo_root(&dir), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn repo_root_without_git_on_path_is_an_honest_none() {
        let dir = temp_dir("repo-root-no-git");

        // An unspawnable binary is how a machine without git looks to the
        // probe; the spawn fails and collapses to None rather than failing
        // the hook.
        assert_eq!(
            probe_repo_root("clock-in-git-that-is-not-installed", &dir),
            None
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two worktrees of one repository are two roots and one remote. That is
    /// the whole reason identity keys on the remote: keyed on the root, this
    /// repository would have minted an agent per worktree.
    #[tokio::test]
    async fn repo_remote_is_the_same_in_every_worktree() {
        let dir = temp_dir("repo-remote");
        init_repo(&dir).await;
        commit_at(&dir, "a.txt", "first", 1_700_000_000).await;
        run(
            &dir,
            &[
                "remote",
                "add",
                "origin",
                "git@github.com:fpresta0607/clock-in.git",
            ],
        )
        .await;
        let worktree = dir.join("..").join(format!(
            "{}-worktree",
            dir.file_name().expect("a name").to_string_lossy()
        ));
        run(
            &dir,
            &["worktree", "add", "-b", "side", &worktree.to_string_lossy()],
        )
        .await;

        assert_eq!(
            repo_remote(&dir).as_deref(),
            Some("git@github.com:fpresta0607/clock-in.git")
        );
        assert_eq!(repo_remote(&worktree), repo_remote(&dir));
        // The roots differ, which is exactly what used to split them.
        assert_ne!(repo_root(&worktree), repo_root(&dir));

        let _ = std::fs::remove_dir_all(&worktree);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn repo_remote_of_a_repository_with_no_origin_is_an_honest_none() {
        let dir = temp_dir("repo-remote-local-only");
        init_repo(&dir).await;
        commit_at(&dir, "a.txt", "first", 1_700_000_000).await;

        // A local-only repository is legitimate; the server keys it on its
        // root instead, rather than pooling every one of them together.
        assert_eq!(repo_remote(&dir), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A working directory that is not a checkout names no repository, and
    /// must not borrow one. `config --get` without `--local` is the one git
    /// subcommand that does not fail outside a repository: it falls through to
    /// global config, so on a machine where `remote.origin.url` happens to be
    /// set globally this probe would return a repository the shift never
    /// touched, while `repo_root` correctly returned `None` - and
    /// `identityRepoKey` keys on the remote first, so that shift would be
    /// attributed to someone else's codebase.
    ///
    /// `GIT_CONFIG_GLOBAL` makes that hazard the test's own condition rather
    /// than a property of whoever runs it: the fixture below sets exactly the
    /// key the probe reads, so dropping `--local` fails here every time. It is
    /// handed to the probe's own child process rather than set on this one,
    /// which every other test in this module shares while shelling out to git.
    #[test]
    fn repo_remote_of_a_non_repo_directory_is_an_honest_none() {
        let dir = temp_dir("repo-remote-plain");
        let global = dir.join("gitconfig-global");
        std::fs::write(
            &global,
            "[remote \"origin\"]\n\turl = https://github.com/someone/unrelated.git\n",
        )
        .expect("global config writes");

        assert_eq!(
            probe_repo_remote("git", &dir, &[("GIT_CONFIG_GLOBAL", global.as_os_str())]),
            None
        );
        // The root probe already got this right, and the two have to agree:
        // a shift with no root must not arrive carrying a remote.
        assert_eq!(repo_root(&dir), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn repo_remote_without_git_on_path_is_an_honest_none() {
        let dir = temp_dir("repo-remote-no-git");

        assert_eq!(
            probe_repo_remote("clock-in-git-that-is-not-installed", &dir, &[]),
            None
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A token-authenticated clone keeps its credential in the remote, and the
    /// remote now leaves this machine on every agent session start. The server
    /// discards `userinfo` when it normalizes, but a secret discarded after
    /// transmission was still transmitted, so it never goes on the wire.
    #[tokio::test]
    async fn repo_remote_strips_embedded_credentials() {
        // Shaped unlike any real token so a secret scanner never flags the fixture.
        let fake_token = "fixture-credential";
        let dir = temp_dir("repo-remote-credentialed");
        init_repo(&dir).await;
        commit_at(&dir, "a.txt", "first", 1_700_000_000).await;
        run(
            &dir,
            &[
                "remote",
                "add",
                "origin",
                &format!("https://x-access-token:{fake_token}@github.com/acme/clock-in.git"),
            ],
        )
        .await;

        let remote = repo_remote(&dir).expect("a remote");

        assert_eq!(remote, "https://github.com/acme/clock-in.git");
        assert!(!remote.contains(fake_token));
        assert!(!remote.contains("x-access-token"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn credential_stripping_keeps_every_other_spelling_intact() {
        // Host, port and path survive; only the credential goes.
        assert_eq!(
            without_embedded_credentials("https://user:secret@dev.azure.test:8443/org/proj/_git/repo"),
            "https://dev.azure.test:8443/org/proj/_git/repo"
        );
        assert_eq!(
            without_embedded_credentials("ssh://git@github.com/acme/api.git"),
            "ssh://github.com/acme/api.git"
        );
        assert_eq!(
            without_embedded_credentials("https://github.com/acme/api.git"),
            "https://github.com/acme/api.git"
        );
        // The scp-style form carries a transport user name, not a credential,
        // and dropping it would leave a string git never wrote.
        assert_eq!(
            without_embedded_credentials("git@github.com:acme/api.git"),
            "git@github.com:acme/api.git"
        );
        // An `@` in the path is not userinfo, so the authority is where the
        // search stops.
        assert_eq!(
            without_embedded_credentials("https://github.com/acme/api@2.git"),
            "https://github.com/acme/api@2.git"
        );
    }

    #[tokio::test]
    async fn commits_in_window_filters_by_authored_at() {
        let dir = temp_dir("window");
        init_repo(&dir).await;
        commit_at(&dir, "a.txt", "before the window", 1_700_000_000).await;
        let start_head = head(&dir);
        commit_at(&dir, "b.txt", "inside the window", 1_700_001_000).await;
        commit_at(&dir, "c.txt", "after the window", 1_700_002_000).await;

        let commits = commits_in_window(&dir, &start_head, 1_700_000_500, 1_700_001_500).await;

        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].subject, "inside the window");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The shift's own commits are what it records. History that was already
    /// reachable when the shift opened is outside `start_head..HEAD`, even
    /// when its author dates land inside the window.
    #[tokio::test]
    async fn commits_in_window_ignores_history_that_predates_the_shift() {
        let dir = temp_dir("start-head");
        init_repo(&dir).await;
        commit_at(&dir, "a.txt", "already in history", 1_700_001_000).await;
        let start_head = head(&dir);
        commit_at(&dir, "b.txt", "the shift's own commit", 1_700_001_100).await;

        let commits = commits_in_window(&dir, &start_head, 1_700_000_500, 1_700_001_500).await;

        assert_eq!(
            commits
                .iter()
                .map(|commit| commit.subject.as_str())
                .collect::<Vec<_>>(),
            ["the shift's own commit"],
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The review's reproduction: a `git pull` part-way through a shift makes
    /// three teammate commits reachable from `HEAD`, all authored inside the
    /// window. They were committed on another machine, so they are that
    /// teammate's work and never this agent's.
    #[tokio::test]
    async fn commits_in_window_ignores_work_pulled_from_a_teammate_mid_shift() {
        let root = temp_dir("mid-shift-pull");
        let origin = root.join("origin");
        let work = root.join("work");
        let mate = root.join("mate");
        init_bare_origin(&origin).await;
        for (clone, email, name) in [
            (&work, "shift@example.test", "Shift Test"),
            (&mate, "mate@example.test", "Team Mate"),
        ] {
            std::fs::create_dir_all(clone).expect("clone dir creates");
            init_repo(clone).await;
            run(clone, &["config", "user.email", email]).await;
            run(clone, &["config", "user.name", name]).await;
            run(
                clone,
                &[
                    "remote",
                    "add",
                    "origin",
                    origin.to_str().expect("utf8 path"),
                ],
            )
            .await;
        }
        commit_at(&work, "base.txt", "base", 1_700_000_000).await;
        push_and_fetch(&work).await;
        run(&mate, &["fetch", "origin"]).await;
        run(&mate, &["reset", "--hard", "origin/main"]).await;

        let start_head = head(&work);
        commit_at(&mate, "mate-1.txt", "teammate change 1", 1_700_001_100).await;
        commit_at(&mate, "mate-2.txt", "teammate change 2", 1_700_001_200).await;
        run(&mate, &["push", "origin", "main"]).await;
        commit_at(&work, "shift.txt", "the agent's own commit", 1_700_001_300).await;
        // The pull: setup only, and the one place this suite touches a remote.
        run(&work, &["pull", "--rebase", "origin", "main"]).await;

        let commits = commits_in_window(&work, &start_head, 1_700_001_000, 1_700_002_000).await;

        assert_eq!(
            commits
                .iter()
                .map(|commit| commit.subject.as_str())
                .collect::<Vec<_>>(),
            ["the agent's own commit"],
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn commits_in_window_on_a_non_repo_cwd_records_nothing() {
        let dir = temp_dir("non-repo");

        let commits = commits_in_window(&dir, &"0".repeat(40), 0, u64::MAX).await;

        assert!(commits.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn discover_repo_on_a_non_repo_cwd_is_none() {
        let dir = temp_dir("discover-non-repo");

        assert!(discover_repo(&dir).await.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn discover_repo_resolves_the_toplevel_and_current_branch() {
        let dir = temp_dir("discover");
        init_repo(&dir).await;
        commit_at(&dir, "a.txt", "first commit", 1_000).await;
        let nested = dir.join("nested");
        std::fs::create_dir_all(&nested).expect("nested dir creates");

        let location = discover_repo(&nested).await.expect("repo discovers");

        assert_eq!(
            std::fs::canonicalize(&location.root).expect("root canonicalizes"),
            std::fs::canonicalize(&dir).expect("dir canonicalizes"),
        );
        assert!(location.branch.is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn subjects_longer_than_the_check_constraint_are_truncated() {
        assert_eq!(truncate_subject(&"x".repeat(600)).chars().count(), 500);
        assert_eq!(truncate_subject("short"), "short");
    }

    /// Sets up a bare `origin` and a `work` clone-equivalent tracking it, with
    /// one base commit already on `main` in both. Returns `work`'s path; the
    /// caller adds its own commits on top and pushes/fetches as each scenario
    /// needs.
    async fn origin_and_work_with_a_base_commit(name: &str) -> (PathBuf, PathBuf) {
        let root = temp_dir(name);
        let origin = root.join("origin");
        let work = root.join("work");
        init_bare_origin(&origin).await;
        std::fs::create_dir_all(&work).expect("work dir creates");
        init_repo(&work).await;
        run(
            &work,
            &[
                "remote",
                "add",
                "origin",
                origin.to_str().expect("utf8 path"),
            ],
        )
        .await;
        commit_at(&work, "base.txt", "base", 1_700_000_000).await;
        push_and_fetch(&work).await;
        (root, work)
    }

    #[tokio::test]
    async fn verify_reports_merged_once_the_default_ref_carries_the_commit() {
        let (root, work) = origin_and_work_with_a_base_commit("merged").await;
        commit_at(&work, "shift.txt", "the shift commit", 1_700_001_000).await;
        let sha = head(&work);
        push_and_fetch(&work).await;

        let outcome = verify(&work, &sha, &crate::monitor::iso8601(1_700_001_000)).await;

        assert_eq!(outcome, Verification::Merged);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// GitHub's "Squash and merge" puts one new commit on the default branch
    /// and people delete the branch afterward, so the captured sha is neither
    /// an ancestor of `main` nor contained by any local ref. Its patch is on
    /// `main` all the same, and that is what held.
    #[tokio::test]
    async fn verify_reports_merged_for_a_squash_merge_whose_branch_was_deleted() {
        let (root, work) = origin_and_work_with_a_base_commit("squash-merged").await;
        run(&work, &["checkout", "--quiet", "-b", "feature"]).await;
        commit_at(&work, "shift.txt", "the shift commit", 1_700_001_000).await;
        let sha = head(&work);
        run(&work, &["checkout", "--quiet", "main"]).await;
        run(&work, &["merge", "--squash", "feature"]).await;
        commit_with_message(&work, "squashed feature (#7)", 1_700_001_500).await;
        push_and_fetch(&work).await;
        run(&work, &["branch", "-D", "feature"]).await;

        let outcome = verify(&work, &sha, &crate::monitor::iso8601(1_700_001_000)).await;

        assert_eq!(outcome, Verification::Merged);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// "Rebase and merge" replays the commit onto the default branch under a
    /// new sha. Same patch, same verdict.
    #[tokio::test]
    async fn verify_reports_merged_for_a_rebase_merge_whose_branch_was_deleted() {
        let (root, work) = origin_and_work_with_a_base_commit("rebase-merged").await;
        run(&work, &["checkout", "--quiet", "-b", "feature"]).await;
        commit_at(&work, "shift.txt", "the shift commit", 1_700_001_000).await;
        let sha = head(&work);
        run(&work, &["checkout", "--quiet", "main"]).await;
        commit_at(&work, "other.txt", "unrelated main work", 1_700_001_200).await;
        run(&work, &["checkout", "--quiet", "feature"]).await;
        run(&work, &["rebase", "main"]).await;
        run(&work, &["checkout", "--quiet", "main"]).await;
        run(&work, &["merge", "--ff-only", "feature"]).await;
        push_and_fetch(&work).await;
        run(&work, &["branch", "-D", "feature"]).await;

        let outcome = verify(&work, &sha, &crate::monitor::iso8601(1_700_001_000)).await;

        assert_eq!(outcome, Verification::Merged);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Work that was genuinely thrown away still reads orphaned: its patch is
    /// nowhere on the default branch and nothing names it.
    #[tokio::test]
    async fn verify_reports_orphaned_for_an_abandoned_branch() {
        let (root, work) = origin_and_work_with_a_base_commit("abandoned").await;
        run(&work, &["checkout", "--quiet", "-b", "abandoned"]).await;
        commit_at(&work, "abandoned.txt", "work nobody kept", 1_700_001_000).await;
        let sha = head(&work);
        run(&work, &["checkout", "--quiet", "main"]).await;
        run(&work, &["branch", "-D", "abandoned"]).await;

        let outcome = verify(&work, &sha, &crate::monitor::iso8601(1_700_001_000)).await;

        assert_eq!(outcome, Verification::Orphaned);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A cherry-pick with `-x` names the original in its trailer, which is the
    /// same evidence a squash commit body carries on hosts that list what they
    /// squashed.
    #[tokio::test]
    async fn verify_reports_merged_when_the_default_ref_names_the_commit() {
        let (root, work) = origin_and_work_with_a_base_commit("referenced").await;
        run(&work, &["checkout", "--quiet", "-b", "feature"]).await;
        commit_at(&work, "shift.txt", "the shift commit", 1_700_001_000).await;
        let sha = head(&work);
        run(&work, &["checkout", "--quiet", "main"]).await;
        // A different tree change, so only the message reference can decide it.
        std::fs::write(work.join("landed.txt"), "landed").expect("scratch file writes");
        run(&work, &["add", "-A"]).await;
        commit_with_message(
            &work,
            &format!("re-landed the shift work\n\n(cherry picked from commit {sha})"),
            1_700_001_500,
        )
        .await;
        push_and_fetch(&work).await;
        run(&work, &["branch", "-D", "feature"]).await;

        let outcome = verify(&work, &sha, &crate::monitor::iso8601(1_700_001_000)).await;

        assert_eq!(outcome, Verification::Merged);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn verify_reports_reverted_even_though_the_original_stays_an_ancestor() {
        let (root, work) = origin_and_work_with_a_base_commit("reverted").await;
        commit_at(&work, "shift.txt", "the shift commit", 1_700_001_000).await;
        let sha = head(&work);
        push_and_fetch(&work).await;

        let revert_date = crate::monitor::iso8601(1_700_002_000);
        let status = Command::new("git")
            .args(["revert", "--no-edit", &sha])
            .current_dir(&work)
            .env("GIT_AUTHOR_DATE", &revert_date)
            .env("GIT_COMMITTER_DATE", &revert_date)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .expect("git revert runs");
        assert!(status.success(), "the revert commits cleanly");
        push_and_fetch(&work).await;

        let outcome = verify(&work, &sha, &crate::monitor::iso8601(1_700_001_000)).await;

        assert_eq!(outcome, Verification::Reverted);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn verify_reports_orphaned_for_a_sha_that_was_never_committed() {
        let (root, work) = origin_and_work_with_a_base_commit("orphaned").await;
        let never_committed_sha = "f".repeat(40);

        let outcome = verify(
            &work,
            &never_committed_sha,
            &crate::monitor::iso8601(1_700_000_500),
        )
        .await;

        assert_eq!(outcome, Verification::Orphaned);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn verify_reports_pending_for_an_unpushed_commit_with_no_remote() {
        let dir = temp_dir("no-remote-pending");
        init_repo(&dir).await;
        commit_at(&dir, "a.txt", "local only", 1_700_000_000).await;
        let sha = head(&dir);

        let outcome = verify(&dir, &sha, &crate::monitor::iso8601(1_700_000_000)).await;

        assert_eq!(outcome, Verification::Pending);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
