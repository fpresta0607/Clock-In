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
        run(dir, &["init", "--quiet"]).await;
        run(dir, &["config", "user.email", "shift@example.test"]).await;
        run(dir, &["config", "user.name", "Shift Test"]).await;
        run(dir, &["config", "commit.gpgsign", "false"]).await;
    }

    /// Commits with an explicit author/committer date, so window-filtering
    /// tests control exactly when each commit "happened" instead of racing
    /// the wall clock.
    async fn commit_at(dir: &Path, file_name: &str, message: &str, unix_time: u64) {
        std::fs::write(dir.join(file_name), message).expect("scratch file writes");
        let date = crate::monitor::iso8601(unix_time);
        let status = Command::new("git")
            .args(["commit", "--quiet", "--allow-empty", "-a", "-m", message])
            .current_dir(dir)
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .expect("git commit runs");
        if !status.success() {
            run(dir, &["add", "-A"]).await;
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
}
