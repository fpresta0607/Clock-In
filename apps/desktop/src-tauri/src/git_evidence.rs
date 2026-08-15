//! Read-only git evidence for shift commits: discovering a repo, listing the
//! commits authored during a shift's window, and later checking whether they
//! made it into the main line.
//!
//! Every command here reads what is already on disk. Nothing fetches, pulls,
//! or writes — a shift's evidence must never depend on network access, and a
//! read-only tool must never mutate the repo it is reporting on.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// git can hang on a slow filesystem or a huge pack; a shift's capture must
/// never block the uploader indefinitely over it.
const GIT_TIMEOUT: Duration = Duration::from_secs(10);

/// Safety margin against clock skew between this machine and the commit's
/// author date. The real window bound is re-applied in Rust afterward, which
/// is authoritative — git's own `--since` only narrows what is fetched.
const WINDOW_SAFETY_MARGIN_SECS: u64 = 24 * 60 * 60;

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

/// One commit authored during a shift, ready to become a `shift_commits` row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitEvidence {
    pub sha: String,
    pub authored_at: String,
    pub subject: String,
}

/// Lists commits on `HEAD` authored within `[started_at, ended_at]` (unix
/// seconds, inclusive). git's own `--since` is only a coarse prefilter with a
/// safety margin for clock skew; the real bound is enforced here against each
/// commit's own author date, which is authoritative.
pub async fn commits_in_window(root: &Path, started_at: u64, ended_at: u64) -> Vec<CommitEvidence> {
    let since = started_at.saturating_sub(WINDOW_SAFETY_MARGIN_SECS);
    let Some(output) = run_git(
        root,
        &[
            "log",
            "HEAD",
            &format!("--since=@{since}"),
            "--pretty=format:%H%x1f%aI%x1f%s",
        ],
    )
    .await
    else {
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

/// Checks a captured commit against the repo on disk: explicitly reverted on
/// the default ref, merged into it, no longer reachable from any local ref
/// (orphaned), or still undecided (pending). Every ref walked here already
/// exists locally — nothing is fetched.
///
/// Reverted is checked before merged: a revert commit does not remove the
/// original from history, so a reverted commit is still its own ancestor —
/// checking merged first would report work that did not hold as if it did.
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

    async fn head_sha(dir: &Path) -> String {
        run_git(dir, &["rev-parse", "HEAD"])
            .await
            .expect("HEAD resolves")
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
    async fn commit_at(dir: &Path, file_name: &str, message: &str, unix_time: u64) {
        std::fs::write(dir.join(file_name), message).expect("scratch file writes");
        run(dir, &["add", "-A"]).await;
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

    #[tokio::test]
    async fn commits_in_window_filters_by_authored_at() {
        let dir = temp_dir("window");
        init_repo(&dir).await;
        commit_at(&dir, "a.txt", "before the window", 1_700_000_000).await;
        commit_at(&dir, "b.txt", "inside the window", 1_700_001_000).await;
        commit_at(&dir, "c.txt", "after the window", 1_700_002_000).await;

        let commits = commits_in_window(&dir, 1_700_000_500, 1_700_001_500).await;

        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].subject, "inside the window");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn commits_in_window_on_a_non_repo_cwd_records_nothing() {
        let dir = temp_dir("non-repo");

        let commits = commits_in_window(&dir, 0, u64::MAX).await;

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
        let sha = head_sha(&work).await;
        push_and_fetch(&work).await;

        let outcome = verify(&work, &sha, &crate::monitor::iso8601(1_700_001_000)).await;

        assert_eq!(outcome, Verification::Merged);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn verify_reports_reverted_even_though_the_original_stays_an_ancestor() {
        let (root, work) = origin_and_work_with_a_base_commit("reverted").await;
        commit_at(&work, "shift.txt", "the shift commit", 1_700_001_000).await;
        let sha = head_sha(&work).await;
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
        let sha = head_sha(&dir).await;

        let outcome = verify(&dir, &sha, &crate::monitor::iso8601(1_700_000_000)).await;

        assert_eq!(outcome, Verification::Pending);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
