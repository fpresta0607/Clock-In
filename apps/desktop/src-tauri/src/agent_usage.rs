//! Agent-usage capture: token counters from a runtime's own session log.
//!
//! One sidecar, `agent-usage.json`, guarded by the spool's interprocess lock
//! (the shift-commits precedent: one lock file per subsystem, not per file).
//! It is the durable registry of, per agent session
//! (`source|external_session_id`):
//!
//! - a read cursor per transcript file (offset plus file identity), so a pass
//!   resumes where the last one stopped and a rotated, truncated, or replaced
//!   transcript is re-read from the start instead of double-counted;
//! - per-(hour bucket, model, sidechain) cumulative token counters, each with
//!   a client id, a synced flag, and a rejected flag. Counters only restate
//!   upward: a re-read recomputes a total, it never adds to one.
//!
//! The reader parses ONLY the numeric usage fields, the model, the timestamp,
//! and the sidechain flag. Nothing the transcript says is retained, logged,
//! or uploaded: no line, prompt, tool argument, file path, or branch name.
//! The registry holds counts, plus the transcript's own path as the tail
//! pointer (it never leaves the machine). A missing or unreadable file is a
//! state, not an error: the counters simply do not advance.

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::browser::write_if_changed_locked;
use crate::monitor::{iso8601, parse_iso8601};
use crate::spool::{self, AgentEventKind, AgentSource, SpoolEvent, TokenCounters};

/// Upper bound on what one pass reads from one transcript file. The next pass
/// resumes at the stored offset, so a fast-growing log is caught up with
/// incrementally rather than in one unbounded read.
const MAX_FILE_BYTES_PER_PASS: u64 = 4 * 1024 * 1024;

fn session_key(source: &AgentSource, external_session_id: &str) -> String {
    format!("{}|{external_session_id}", source.as_str())
}

/// One session's counters for one hour bucket, carried end to end: captured
/// here, uploaded by the uploader, restated upward until the server accepts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    pub client_id: String,
    pub source: AgentSource,
    pub external_session_id: String,
    pub bucket_start_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default)]
    pub sidechain: bool,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    #[serde(default)]
    pub synced: bool,
    #[serde(default)]
    pub rejected: bool,
}

/// Resolved token counts. Unlike `TokenCounters` (what a hook reported, each
/// counter optional), these are sums: zero means "none counted", not "the
/// hook did not say".
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenTotals {
    #[serde(default)]
    input: u64,
    #[serde(default)]
    output: u64,
    #[serde(default)]
    cache_creation: u64,
    #[serde(default)]
    cache_read: u64,
}

impl TokenTotals {
    /// What a hook's cumulative counters resolve to; `None` when the hook
    /// reported nothing at all.
    fn from_counters(counters: &TokenCounters) -> Option<Self> {
        let totals = Self {
            input: counters.input_tokens.unwrap_or(0),
            output: counters.output_tokens.unwrap_or(0),
            cache_creation: counters.cache_creation_input_tokens.unwrap_or(0),
            cache_read: counters.cache_read_input_tokens.unwrap_or(0),
        };
        (counters.input_tokens.is_some()
            || counters.output_tokens.is_some()
            || counters.cache_creation_input_tokens.is_some()
            || counters.cache_read_input_tokens.is_some())
        .then_some(totals)
    }

    fn is_zero(&self) -> bool {
        self.input == 0 && self.output == 0 && self.cache_creation == 0 && self.cache_read == 0
    }

    fn add(&mut self, other: &Self) {
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
        self.cache_creation = self.cache_creation.saturating_add(other.cache_creation);
        self.cache_read = self.cache_read.saturating_add(other.cache_read);
    }

    fn take_max(&mut self, other: &Self) {
        self.input = self.input.max(other.input);
        self.output = self.output.max(other.output);
        self.cache_creation = self.cache_creation.max(other.cache_creation);
        self.cache_read = self.cache_read.max(other.cache_read);
    }
}

/// Totals for one (hour bucket, model, sidechain) combination, as one source
/// (one transcript file, or the hook's own reports) summed them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BucketTotals {
    bucket_start_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default)]
    sidechain: bool,
    #[serde(default)]
    tokens: TokenTotals,
}

/// The read cursor for one transcript file. `buckets` is this file's own
/// cumulative sums: a session's counters are the sum over its files plus the
/// hook-reported maximum, so re-reading a file recomputes its contribution
/// instead of adding to it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileUsage {
    /// Byte offset the next pass resumes at.
    #[serde(default)]
    offset: u64,
    /// Birth time of the file the offset belongs to, in unix milliseconds. A
    /// file replaced since has a different one and is re-read from the start.
    /// `None` on filesystems that cannot answer, where only the shrink check
    /// detects a fresh file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    identity_ms: Option<u64>,
    /// Set when an over-ceiling line forced the reader to skip ahead: bytes
    /// up to the next newline are the middle of that line and are discarded.
    #[serde(default)]
    resync: bool,
    #[serde(default)]
    buckets: Vec<BucketTotals>,
}

/// One agent session's capture state.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionUsage {
    #[serde(default, skip_serializing_if = "AgentSource::is_empty_for_default")]
    source: AgentSource,
    #[serde(default)]
    external_session_id: String,
    /// The transcript the hook pointed at; the tail pointer, never uploaded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    transcript_path: Option<String>,
    /// The session's working directory, remembered for the model heartbeat,
    /// which must carry one to satisfy the agent-event contract. Persisted
    /// because the spool line that carried it may have drained already.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    /// The hook already named a model, so the transcript reader must not
    /// emit a model-bearing heartbeat for this session.
    #[serde(default)]
    model_from_hook: bool,
    /// The one model heartbeat this session ever emits has been emitted.
    #[serde(default)]
    heartbeat_sent: bool,
    /// Cumulative totals the hook itself reported (the `--input-tokens` flag
    /// family), kept as the maximum restatement in the hour of the first
    /// report, per model. Flag totals name no turn, so they cannot follow the
    /// transcript's per-entry bucketing.
    #[serde(default)]
    hook_buckets: Vec<BucketTotals>,
    /// Per transcript file (the main log and each `subagents/*.jsonl`
    /// sibling), keyed by path: the read cursor and the file's bucket sums.
    #[serde(default)]
    files: HashMap<String, FileUsage>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageRegistry {
    #[serde(default)]
    sessions: HashMap<String, SessionUsage>,
    #[serde(default)]
    entries: Vec<UsageEntry>,
}

fn read_json_sidecar<T: Default + serde::de::DeserializeOwned>(path: &Path) -> T {
    let Ok(bytes) = std::fs::read(path) else {
        return T::default();
    };
    match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => {
            quarantine_corrupt(path, &bytes);
            T::default()
        }
    }
}

/// A sidecar that fails to parse is moved aside rather than left to fail
/// every future read; capture resumes from empty state instead of stalling
/// on a file nothing can repair.
fn quarantine_corrupt(path: &Path, bytes: &[u8]) {
    let mut name = path.as_os_str().to_owned();
    name.push(".corrupt");
    let _ = std::fs::write(PathBuf::from(name), bytes);
}

fn read_registry(path: &Path) -> UsageRegistry {
    read_json_sidecar(path)
}

fn write_registry(path: &Path, registry: &UsageRegistry) -> spool::SpoolResult<()> {
    let bytes = serde_json::to_vec(registry).map_err(std::io::Error::other)?;
    write_if_changed_locked(path, &bytes)
}

/// The hour a timestamp belongs to, hour-aligned and back in ISO form.
fn hour_bucket(timestamp: &str) -> Option<String> {
    let at = parse_iso8601(timestamp)?;
    Some(iso8601(at - at % 3_600))
}

/// The files one session's counters sum over: the main transcript the hook
/// named, plus every `subagents/agent-*.jsonl` sibling beside it (Claude Code
/// writes sub-agent logs at `<slug>/<sessionId>/subagents/`). Nothing is
/// guessed: every path derives from the hook's `transcript_path`.
fn transcript_files(transcript_path: &Path) -> Vec<PathBuf> {
    let mut files = vec![transcript_path.to_path_buf()];
    let (Some(stem), Some(parent)) = (transcript_path.file_stem(), transcript_path.parent()) else {
        return files;
    };
    let subagents = parent.join(stem).join("subagents");
    if let Ok(read_dir) = std::fs::read_dir(subagents) {
        let mut extra: Vec<PathBuf> = read_dir
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("agent-") && name.ends_with(".jsonl"))
            })
            .collect();
        extra.sort();
        files.extend(extra);
    }
    files
}

/// What one transcript line is allowed to teach us. Every other key the line
/// carries - prompt text, tool calls, file paths - is never deserialized.
#[derive(Debug, Deserialize)]
struct TranscriptLine {
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default, rename = "isSidechain")]
    is_sidechain: bool,
    #[serde(default)]
    message: Option<TranscriptMessage>,
}

#[derive(Debug, Deserialize)]
struct TranscriptMessage {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    usage: Option<TranscriptUsage>,
}

#[derive(Debug, Deserialize)]
struct TranscriptUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
}

/// The outcome of one incremental read: the cursor to persist, and the model
/// this pass learned if the file named one.
struct FileTail {
    cursor: FileUsage,
    learned_model: Option<String>,
}

/// A transcript entry the CLI wrote about itself rather than one a model
/// produced. Claude Code stamps such entries `<synthetic>`, and because the
/// reader keeps the *first* model a transcript names, one of them at the top of
/// a file became the shift's recorded model - a roster row reading
/// "Claude Code · <synthetic>". A name in angle brackets is a placeholder, not
/// a model, so the reader keeps looking; a shift that never names a real one
/// stays null and reads "not recorded", which is already the honest answer.
fn is_placeholder_model(model: &str) -> bool {
    model.starts_with('<') && model.ends_with('>')
}

/// Reads new complete lines from a transcript, starting at the cursor.
/// Returns `None` when nothing advanced - a missing file, an unreadable
/// file, or no new complete lines: all states, not errors.
///
/// A file whose identity changed or that shrank below the stored offset is
/// treated as a fresh read: its contribution is recomputed from its current
/// content, so no byte is ever counted twice. A trailing partial line is
/// left unconsumed until it completes; a complete line over the spool's
/// record ceiling is consumed without being parsed (and an unterminated one
/// forces `resync`, discarding its middle on later passes).
fn tail_file(path: &Path, cursor: &FileUsage) -> Option<FileTail> {
    let metadata = std::fs::metadata(path).ok()?;
    let len = metadata.len();
    let identity_ms = metadata
        .created()
        .ok()
        .and_then(|created| created.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since_epoch| since_epoch.as_millis() as u64);

    let fresh = cursor.identity_ms != identity_ms || len < cursor.offset;
    let (mut buckets, start, mut resync) = if fresh {
        (Vec::new(), 0, false)
    } else {
        (cursor.buckets.clone(), cursor.offset, cursor.resync)
    };
    if len == start {
        // No new bytes. A first sighting still records the identity so a
        // later replacement is detectable.
        if fresh {
            return Some(FileTail {
                cursor: FileUsage {
                    offset: start,
                    identity_ms,
                    resync,
                    buckets,
                },
                learned_model: None,
            });
        }
        return None;
    }

    let window_end = start.saturating_add(MAX_FILE_BYTES_PER_PASS).min(len);
    let mut file = std::fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = vec![0_u8; (window_end - start) as usize];
    file.read_exact(&mut bytes).ok()?;

    let mut offset = start;
    if resync {
        match bytes.iter().position(|byte| *byte == b'\n') {
            Some(index) => {
                offset += index as u64 + 1;
                resync = false;
            }
            None => {
                // Still inside the over-ceiling line. Advance only when more
                // of the file is known to follow; otherwise wait for it.
                if window_end < len {
                    return Some(FileTail {
                        cursor: FileUsage {
                            offset: window_end,
                            identity_ms,
                            resync: true,
                            buckets,
                        },
                        learned_model: None,
                    });
                }
                return None;
            }
        }
    }

    let content = &bytes[(offset - start) as usize..];
    let complete_len = content
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(0);

    if complete_len == 0 && window_end < len {
        // One unterminated line fills the whole per-pass window: it exceeds
        // every ceiling a record may have, so skip ahead and let the resync
        // above discard its middle on the following passes.
        return Some(FileTail {
            cursor: FileUsage {
                offset: window_end,
                identity_ms,
                resync: true,
                buckets,
            },
            learned_model: None,
        });
    }

    let mut learned_model: Option<String> = None;
    for line in content[..complete_len].split(|byte| *byte == b'\n') {
        if line.is_empty() || line.len() > spool::MAX_SPOOL_RECORD_BYTES {
            continue;
        }
        let Ok(entry) = serde_json::from_slice::<TranscriptLine>(line) else {
            continue;
        };
        let model = entry
            .message
            .as_ref()
            .and_then(|message| message.model.as_deref())
            .map(str::trim)
            .filter(|model| !model.is_empty() && !is_placeholder_model(model));
        if learned_model.is_none() {
            learned_model = model.map(str::to_string);
        }
        let (Some(usage), Some(timestamp)) = (
            entry
                .message
                .as_ref()
                .and_then(|message| message.usage.as_ref()),
            entry.timestamp.as_deref(),
        ) else {
            continue;
        };
        let Some(bucket_start_at) = hour_bucket(timestamp) else {
            continue;
        };
        let tokens = TokenTotals {
            input: usage.input_tokens,
            output: usage.output_tokens,
            cache_creation: usage.cache_creation_input_tokens,
            cache_read: usage.cache_read_input_tokens,
        };
        match buckets.iter_mut().find(|bucket| {
            bucket.bucket_start_at == bucket_start_at
                && bucket.model.as_deref() == model
                && bucket.sidechain == entry.is_sidechain
        }) {
            Some(bucket) => bucket.tokens.add(&tokens),
            None => buckets.push(BucketTotals {
                bucket_start_at,
                model: model.map(str::to_string),
                sidechain: entry.is_sidechain,
                tokens,
            }),
        }
    }
    offset += complete_len as u64;

    if offset == cursor.offset && !fresh {
        return None;
    }
    Some(FileTail {
        cursor: FileUsage {
            offset,
            identity_ms,
            resync,
            buckets,
        },
        learned_model,
    })
}

/// Folds one spool event into the registry: registers the session, learns
/// the transcript path, the cwd, and whether the hook named a model, and
/// takes the maximum of any hook-reported cumulative totals.
fn fold_event(registry: &mut UsageRegistry, event: &SpoolEvent) {
    let key = session_key(&event.source, &event.external_session_id);
    let session = registry
        .sessions
        .entry(key)
        .or_insert_with(|| SessionUsage {
            source: event.source.clone(),
            external_session_id: event.external_session_id.clone(),
            ..SessionUsage::default()
        });
    if let Some(cwd) = event.cwd.as_deref().filter(|cwd| !cwd.trim().is_empty()) {
        session.cwd = Some(cwd.to_string());
    }
    if event.model.is_some() {
        session.model_from_hook = true;
    }
    if let Some(path) = event
        .transcript_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
    {
        session.transcript_path = Some(path.to_string());
    }
    let totals = event.tokens.as_ref().and_then(TokenTotals::from_counters);
    let (Some(totals), Some(bucket_start_at)) = (totals, hour_bucket(&event.occurred_at)) else {
        return;
    };
    match session
        .hook_buckets
        .iter_mut()
        .find(|bucket| bucket.model == event.model && !bucket.sidechain)
    {
        Some(bucket) => bucket.tokens.take_max(&totals),
        None => session.hook_buckets.push(BucketTotals {
            bucket_start_at,
            model: event.model.clone(),
            sidechain: false,
            tokens: totals,
        }),
    }
}

/// Rebuilds the uploadable entries from every session's file sums and hook
/// maximums. An entry's counters are the component-wise maximum of what was
/// there and what was computed, so a transcript that shrank never walks a
/// total the server may already have accepted backwards. Any advance re-arms
/// the entry for upload; a permanently rejected entry is left alone.
fn recompute_entries(registry: &mut UsageRegistry) {
    let mut desired: Vec<(String, BucketTotals)> = Vec::new();
    for (key, session) in &registry.sessions {
        let mut totals: BTreeMap<(String, Option<String>, bool), TokenTotals> = BTreeMap::new();
        for file in session.files.values() {
            for bucket in &file.buckets {
                totals
                    .entry((
                        bucket.bucket_start_at.clone(),
                        bucket.model.clone(),
                        bucket.sidechain,
                    ))
                    .or_default()
                    .add(&bucket.tokens);
            }
        }
        for bucket in &session.hook_buckets {
            totals
                .entry((
                    bucket.bucket_start_at.clone(),
                    bucket.model.clone(),
                    bucket.sidechain,
                ))
                .or_default()
                .take_max(&bucket.tokens);
        }
        for ((bucket_start_at, model, sidechain), tokens) in totals {
            if tokens.is_zero() {
                continue;
            }
            desired.push((
                key.clone(),
                BucketTotals {
                    bucket_start_at,
                    model,
                    sidechain,
                    tokens,
                },
            ));
        }
    }

    for (key, computed) in desired {
        let Some(session) = registry.sessions.get(&key) else {
            continue;
        };
        let existing = registry.entries.iter_mut().find(|entry| {
            entry.source == session.source
                && entry.external_session_id == session.external_session_id
                && entry.bucket_start_at == computed.bucket_start_at
                && entry.model == computed.model
                && entry.sidechain == computed.sidechain
        });
        match existing {
            Some(entry) if entry.rejected => {}
            Some(entry) => {
                let mut restated = TokenTotals {
                    input: entry.input_tokens,
                    output: entry.output_tokens,
                    cache_creation: entry.cache_creation_input_tokens,
                    cache_read: entry.cache_read_input_tokens,
                };
                restated.take_max(&computed.tokens);
                let changed = entry.input_tokens != restated.input
                    || entry.output_tokens != restated.output
                    || entry.cache_creation_input_tokens != restated.cache_creation
                    || entry.cache_read_input_tokens != restated.cache_read;
                if changed {
                    entry.input_tokens = restated.input;
                    entry.output_tokens = restated.output;
                    entry.cache_creation_input_tokens = restated.cache_creation;
                    entry.cache_read_input_tokens = restated.cache_read;
                    entry.synced = false;
                }
            }
            None => registry.entries.push(UsageEntry {
                client_id: uuid::Uuid::new_v4().to_string(),
                source: session.source.clone(),
                external_session_id: session.external_session_id.clone(),
                bucket_start_at: computed.bucket_start_at,
                model: computed.model,
                sidechain: computed.sidechain,
                input_tokens: computed.tokens.input,
                output_tokens: computed.tokens.output,
                cache_creation_input_tokens: computed.tokens.cache_creation,
                cache_read_input_tokens: computed.tokens.cache_read,
                synced: false,
                rejected: false,
            }),
        }
    }
}

/// A model the transcript reader learned, ready to ride one heartbeat.
struct PendingHeartbeat {
    key: String,
    source: AgentSource,
    external_session_id: String,
    cwd: String,
    model: String,
}

/// Reads pending agent-spool lines without truncating them - the uploader's
/// own agent-spool drain owns truncation - and tails every known transcript
/// incrementally. Replay is safe because every step is idempotent: offsets
/// make a transcript entry count exactly once, hook totals keep the maximum,
/// and the heartbeat fires once per session.
///
/// When the reader first learns a session's model (Claude Code's hook
/// payload never carries one; the transcript names it within seconds of the
/// first turn), it appends ONE model-bearing heartbeat to the agent spool,
/// which uploads through the normal `/agent-sessions` drain so the server
/// can coalesce the model onto the open session. Never emitted when the hook
/// already named a model.
pub fn capture_from_spool(agent_path: &Path, agent_usage_path: &Path) {
    let Ok(pending) = spool::read_pending(agent_path) else {
        return;
    };

    if !pending.events.is_empty() {
        let folded = spool::with_lock(agent_usage_path, || {
            let mut registry = read_registry(agent_usage_path);
            for event in &pending.events {
                fold_event(&mut registry, event);
            }
            write_registry(agent_usage_path, &registry)
        });
        if folded.is_err() {
            return;
        }
    }

    // The tail plan: every session's main transcript plus its sub-agent
    // siblings, with the cursor each file resumes from. Transcript IO runs
    // unlocked: it can take real time, and nothing else needs the sidecar
    // lock held while it runs.
    let plan: Vec<(String, String, PathBuf, FileUsage)> =
        spool::with_lock(agent_usage_path, || {
            let registry = read_registry(agent_usage_path);
            let mut plan = Vec::new();
            for (key, session) in &registry.sessions {
                let Some(transcript) = session.transcript_path.as_deref() else {
                    continue;
                };
                for file in transcript_files(Path::new(transcript)) {
                    let file_key = file.to_string_lossy().into_owned();
                    let cursor = session.files.get(&file_key).cloned().unwrap_or_default();
                    plan.push((key.clone(), file_key, file, cursor));
                }
            }
            Ok(plan)
        })
        .unwrap_or_default();

    let mut tails: Vec<(String, String, FileTail)> = Vec::new();
    for (key, file_key, path, cursor) in plan {
        if let Some(tail) = tail_file(&path, &cursor) {
            tails.push((key, file_key, tail));
        }
    }
    if tails.is_empty() && pending.events.is_empty() {
        return;
    }

    let mut heartbeats: Vec<PendingHeartbeat> = Vec::new();
    let merged = spool::with_lock(agent_usage_path, || {
        let mut registry = read_registry(agent_usage_path);
        for (key, file_key, tail) in tails {
            let Some(session) = registry.sessions.get_mut(&key) else {
                continue;
            };
            if let Some(model) = &tail.learned_model {
                if !session.heartbeat_sent && !session.model_from_hook {
                    if let Some(cwd) = session.cwd.clone() {
                        heartbeats.push(PendingHeartbeat {
                            key: key.clone(),
                            source: session.source.clone(),
                            external_session_id: session.external_session_id.clone(),
                            cwd,
                            model: model.clone(),
                        });
                    }
                }
            }
            session.files.insert(file_key, tail.cursor);
        }
        recompute_entries(&mut registry);
        write_registry(agent_usage_path, &registry)
    });
    if merged.is_err() {
        return;
    }

    // Heartbeats append through the same path the hook binary uses, so they
    // drain and upload exactly like a hook's own events. The sent flag is
    // recorded only once the line is on disk; a failed append retries next
    // pass, and a crash between append and flag can only ever emit one
    // duplicate, which the server's model coalesce absorbs.
    for heartbeat in heartbeats {
        let event = SpoolEvent {
            source: heartbeat.source,
            external_session_id: heartbeat.external_session_id,
            event: AgentEventKind::Heartbeat,
            occurred_at: spool::now_iso8601(),
            cwd: Some(heartbeat.cwd),
            model: Some(heartbeat.model),
            start_head: None,
            repo_root: None,
            repo_remote: None,
            rule_id: None,
            transcript_path: None,
            tokens: None,
        };
        if spool::append(agent_path, &event).is_ok() {
            let _ = spool::with_lock(agent_usage_path, || {
                let mut registry = read_registry(agent_usage_path);
                if let Some(session) = registry.sessions.get_mut(&heartbeat.key) {
                    session.heartbeat_sent = true;
                }
                write_registry(agent_usage_path, &registry)
            });
        }
    }
}

/// Every entry the uploader has not yet gotten a permanent verdict for.
pub fn unsynced(agent_usage_path: &Path) -> Vec<UsageEntry> {
    spool::with_lock(agent_usage_path, || {
        Ok(read_registry(agent_usage_path)
            .entries
            .into_iter()
            .filter(|entry| !entry.synced && !entry.rejected)
            .collect())
    })
    .unwrap_or_default()
}

/// Marks the given client ids accepted by the server (a permanent, terminal
/// outcome for upload purposes until a later pass restates the total upward).
pub fn mark_synced(agent_usage_path: &Path, client_ids: &[String]) {
    let _ = spool::with_lock(agent_usage_path, || {
        let mut registry = read_registry(agent_usage_path);
        for entry in registry.entries.iter_mut() {
            if client_ids.iter().any(|id| id == &entry.client_id) {
                entry.synced = true;
            }
        }
        write_registry(agent_usage_path, &registry)
    });
}

/// Marks the given client ids permanently rejected by the server - anything
/// other than the retryable `unknown_session` reason, which the caller keeps
/// unsynced instead.
pub fn mark_rejected(agent_usage_path: &Path, client_ids: &[String]) {
    let _ = spool::with_lock(agent_usage_path, || {
        let mut registry = read_registry(agent_usage_path);
        for entry in registry.entries.iter_mut() {
            if client_ids.iter().any(|id| id == &entry.client_id) {
                entry.rejected = true;
            }
        }
        write_registry(agent_usage_path, &registry)
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "siqshift-agent-usage-{name}-{}-{}",
            std::process::id(),
            unique_suffix()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir creates");
        dir
    }

    fn unique_suffix() -> u64 {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    fn source() -> AgentSource {
        AgentSource::parse("claude_code").expect("canonical source parses")
    }

    /// One assistant transcript line, with exactly the keys the reader may
    /// learn from (plus one content key it must ignore).
    fn assistant_line(
        timestamp: &str,
        model: &str,
        sidechain: bool,
        input: u64,
        output: u64,
        cache_creation: u64,
        cache_read: u64,
    ) -> String {
        serde_json::json!({
            "timestamp": timestamp,
            "sessionId": "session-1",
            "cwd": "C:/dev/siqshift",
            "isSidechain": sidechain,
            "message": {
                "model": model,
                "content": [{"type": "text", "text": "words the reader never keeps"}],
                "usage": {
                    "input_tokens": input,
                    "output_tokens": output,
                    "cache_creation_input_tokens": cache_creation,
                    "cache_read_input_tokens": cache_read,
                },
            },
        })
        .to_string()
    }

    fn write_transcript(path: &Path, lines: &[String]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("transcript dir creates");
        }
        let mut body = lines.join("\n");
        if !body.is_empty() {
            body.push('\n');
        }
        std::fs::write(path, body).expect("transcript writes");
    }

    fn append_to_transcript(path: &Path, text: &str) {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .expect("transcript opens");
        file.write_all(text.as_bytes()).expect("transcript appends");
    }

    fn started_event(transcript: &Path, occurred_at: &str, model: Option<&str>) -> SpoolEvent {
        SpoolEvent {
            source: source(),
            external_session_id: "session-1".to_string(),
            event: AgentEventKind::Started,
            occurred_at: occurred_at.to_string(),
            cwd: Some("C:/dev/siqshift".to_string()),
            start_head: None,
            repo_root: None,
            repo_remote: None,
            model: model.map(str::to_string),
            rule_id: None,
            transcript_path: Some(transcript.to_string_lossy().into_owned()),
            tokens: None,
        }
    }

    fn one_entry(registry: &UsageRegistry) -> &UsageEntry {
        assert_eq!(registry.entries.len(), 1, "exactly one entry is expected");
        &registry.entries[0]
    }

    #[test]
    fn a_transcripts_usage_lands_in_an_hour_aligned_bucket() {
        let dir = temp_dir("normal");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        write_transcript(
            &transcript,
            &[
                assistant_line(
                    "2026-08-06T10:15:00Z",
                    "claude-opus-4.1",
                    false,
                    100,
                    20,
                    30,
                    40,
                ),
                assistant_line(
                    "2026-08-06T10:45:00Z",
                    "claude-opus-4.1",
                    false,
                    50,
                    10,
                    0,
                    5,
                ),
                assistant_line("2026-08-06T11:05:00Z", "claude-opus-4.1", false, 7, 3, 0, 0),
            ],
        );
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", None),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);

        let registry = read_registry(&usage_path);
        assert_eq!(registry.entries.len(), 2, "one entry per hour bucket");
        let ten = registry
            .entries
            .iter()
            .find(|entry| entry.bucket_start_at == "2026-08-06T10:00:00Z")
            .expect("the ten o'clock bucket exists");
        assert_eq!(ten.source, source());
        assert_eq!(ten.external_session_id, "session-1");
        assert_eq!(ten.model.as_deref(), Some("claude-opus-4.1"));
        assert!(!ten.sidechain);
        assert_eq!(ten.input_tokens, 150);
        assert_eq!(ten.output_tokens, 30);
        assert_eq!(ten.cache_creation_input_tokens, 30);
        assert_eq!(ten.cache_read_input_tokens, 45);
        assert!(!ten.client_id.is_empty());
        assert!(!ten.synced && !ten.rejected);
        let eleven = registry
            .entries
            .iter()
            .find(|entry| entry.bucket_start_at == "2026-08-06T11:00:00Z")
            .expect("the eleven o'clock bucket exists");
        assert_eq!(eleven.input_tokens, 7);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_grown_transcript_advances_the_counters_exactly_once() {
        let dir = temp_dir("grew");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        write_transcript(
            &transcript,
            &[assistant_line(
                "2026-08-06T10:15:00Z",
                "claude-opus-4.1",
                false,
                100,
                20,
                0,
                0,
            )],
        );
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", None),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);
        let first = read_registry(&usage_path);
        assert_eq!(one_entry(&first).input_tokens, 100);
        let offset_after_first = one_file_offset(&first);
        assert_eq!(
            offset_after_first,
            std::fs::metadata(&transcript).expect("metadata").len()
        );

        // The transcript grows between passes; the uploader has not truncated
        // the spool yet, so the same Started line replays too.
        append_to_transcript(
            &transcript,
            &(assistant_line(
                "2026-08-06T10:50:00Z",
                "claude-opus-4.1",
                false,
                60,
                5,
                1,
                2,
            ) + "\n"),
        );
        capture_from_spool(&agent_path, &usage_path);
        let second = read_registry(&usage_path);
        let grown = one_entry(&second);
        assert_eq!(grown.input_tokens, 160, "only the new line adds");
        assert_eq!(grown.output_tokens, 25);
        assert_eq!(grown.cache_creation_input_tokens, 1);
        assert_eq!(grown.cache_read_input_tokens, 2);
        assert_eq!(
            grown.client_id,
            one_entry(&first).client_id,
            "the bucket restates the same entry"
        );

        // A pass with no growth changes nothing.
        capture_from_spool(&agent_path, &usage_path);
        let third = read_registry(&usage_path);
        assert_eq!(third.entries, second.entries);

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn one_file_offset(registry: &UsageRegistry) -> u64 {
        let session = registry.sessions.values().next().expect("a session exists");
        assert_eq!(session.files.len(), 1, "exactly one file cursor");
        session
            .files
            .values()
            .next()
            .expect("a cursor exists")
            .offset
    }

    #[test]
    fn a_truncated_transcript_is_re_read_without_double_counting() {
        let dir = temp_dir("truncated");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        let first_line = assistant_line(
            "2026-08-06T10:15:00Z",
            "claude-opus-4.1",
            false,
            100,
            20,
            0,
            0,
        );
        let second_line = assistant_line(
            "2026-08-06T10:20:00Z",
            "claude-opus-4.1",
            false,
            80,
            10,
            0,
            0,
        );
        write_transcript(&transcript, &[first_line.clone(), second_line]);
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", None),
        )
        .expect("append succeeds");
        capture_from_spool(&agent_path, &usage_path);
        assert_eq!(one_entry(&read_registry(&usage_path)).input_tokens, 180);

        // Truncated in place: same identity, shorter than the stored offset.
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&transcript)
            .expect("transcript opens");
        file.set_len((first_line.len() + 1) as u64)
            .expect("transcript truncates");
        capture_from_spool(&agent_path, &usage_path);

        let registry = read_registry(&usage_path);
        assert_eq!(
            one_entry(&registry).input_tokens,
            180,
            "a restated total never walks backwards and never double-counts"
        );
        assert_eq!(
            one_file_offset(&registry),
            (first_line.len() + 1) as u64,
            "the cursor restarted from the shrunken file"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_replaced_transcript_starts_a_fresh_read() {
        let dir = temp_dir("replaced");
        let transcript = dir.join("session-1.jsonl");
        write_transcript(
            &transcript,
            &[
                assistant_line(
                    "2026-08-06T10:15:00Z",
                    "claude-opus-4.1",
                    false,
                    40,
                    5,
                    0,
                    0,
                ),
                assistant_line(
                    "2026-08-06T10:20:00Z",
                    "claude-opus-4.1",
                    false,
                    60,
                    5,
                    0,
                    0,
                ),
            ],
        );
        let stale_cursor = FileUsage {
            offset: 10,
            identity_ms: Some(1),
            resync: false,
            buckets: vec![BucketTotals {
                bucket_start_at: "2026-08-06T10:00:00Z".to_string(),
                model: Some("claude-opus-4.1".to_string()),
                sidechain: false,
                tokens: TokenTotals {
                    input: 100,
                    output: 10,
                    cache_creation: 0,
                    cache_read: 0,
                },
            }],
        };

        // A different identity at the same path is a new file: its
        // contribution is recomputed from its current content rather than
        // resumed mid-stream.
        let tail = tail_file(&transcript, &stale_cursor).expect("the replaced file reads");
        assert_eq!(
            tail.cursor.offset,
            std::fs::metadata(&transcript).expect("metadata").len()
        );
        assert_eq!(tail.cursor.buckets.len(), 1);
        assert_eq!(tail.cursor.buckets[0].tokens.input, 100);
        assert_eq!(tail.cursor.buckets[0].tokens.output, 10);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_half_written_last_line_waits_for_its_newline() {
        let dir = temp_dir("partial-line");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        let first_line = assistant_line(
            "2026-08-06T10:15:00Z",
            "claude-opus-4.1",
            false,
            100,
            20,
            0,
            0,
        );
        let second_line = assistant_line(
            "2026-08-06T10:20:00Z",
            "claude-opus-4.1",
            false,
            60,
            5,
            0,
            0,
        );
        let partial = &second_line[..second_line.len() / 2];
        write_transcript(&transcript, &[first_line]);
        append_to_transcript(&transcript, partial);
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", None),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);
        let registry = read_registry(&usage_path);
        assert_eq!(
            one_entry(&registry).input_tokens,
            100,
            "the unterminated line is left unconsumed"
        );

        append_to_transcript(
            &transcript,
            &format!("{}\n", &second_line[second_line.len() / 2..]),
        );
        capture_from_spool(&agent_path, &usage_path);
        let registry = read_registry(&usage_path);
        assert_eq!(
            one_entry(&registry).input_tokens,
            160,
            "the completed line counts exactly once"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sub_agent_transcripts_sum_beside_the_main_log_under_the_sidechain_flag() {
        let dir = temp_dir("subagents");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        write_transcript(
            &transcript,
            &[assistant_line(
                "2026-08-06T10:15:00Z",
                "claude-opus-4.1",
                false,
                100,
                20,
                0,
                0,
            )],
        );
        let subagent = dir
            .join("session-1")
            .join("subagents")
            .join("agent-a1.jsonl");
        write_transcript(
            &subagent,
            &[assistant_line(
                "2026-08-06T10:25:00Z",
                "claude-opus-4.1",
                true,
                40,
                8,
                2,
                0,
            )],
        );
        // A sibling that is not a sub-agent log never participates.
        write_transcript(
            &dir.join("session-1").join("subagents").join("notes.jsonl"),
            &[assistant_line(
                "2026-08-06T10:26:00Z",
                "claude-opus-4.1",
                true,
                999,
                0,
                0,
                0,
            )],
        );
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", None),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);

        let registry = read_registry(&usage_path);
        assert_eq!(registry.entries.len(), 2, "main and sidechain split");
        let main = registry
            .entries
            .iter()
            .find(|entry| !entry.sidechain)
            .expect("the main entry exists");
        assert_eq!(main.input_tokens, 100);
        let sidechain = registry
            .entries
            .iter()
            .find(|entry| entry.sidechain)
            .expect("the sidechain entry exists");
        assert_eq!(sidechain.input_tokens, 40);
        assert_eq!(sidechain.output_tokens, 8);
        assert_eq!(sidechain.cache_creation_input_tokens, 2);
        assert_eq!(sidechain.bucket_start_at, "2026-08-06T10:00:00Z");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_transcript_is_a_state_not_an_error() {
        let dir = temp_dir("missing-file");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("never-written.jsonl");
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", None),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);

        let registry = read_registry(&usage_path);
        assert!(registry.entries.is_empty(), "no counters advance");
        assert_eq!(registry.sessions.len(), 1, "the session still registers");
        let pending = spool::read_pending(&agent_path).expect("the spool reads");
        assert_eq!(pending.events.len(), 1, "capture never truncates the spool");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hook_reported_cumulative_totals_keep_the_maximum() {
        let dir = temp_dir("hook-totals");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        let mut event = started_event(&transcript, "2026-08-06T10:00:00Z", Some("pi-model"));
        event.tokens = Some(TokenCounters {
            input_tokens: Some(100),
            output_tokens: Some(10),
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
        });
        spool::append(&agent_path, &event).expect("append succeeds");
        let mut restated = event.clone();
        restated.event = AgentEventKind::Heartbeat;
        restated.occurred_at = "2026-08-06T10:30:00Z".to_string();
        restated.tokens = Some(TokenCounters {
            input_tokens: Some(150),
            output_tokens: Some(12),
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
        });
        spool::append(&agent_path, &restated).expect("append succeeds");
        // A smaller restatement (a restarted counter) never walks the total back.
        let mut regressed = restated.clone();
        regressed.occurred_at = "2026-08-06T10:31:00Z".to_string();
        regressed.tokens = Some(TokenCounters {
            input_tokens: Some(120),
            output_tokens: Some(12),
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
        });
        spool::append(&agent_path, &regressed).expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);

        let registry = read_registry(&usage_path);
        let entry = one_entry(&registry);
        assert_eq!(entry.input_tokens, 150, "the maximum restatement wins");
        assert_eq!(entry.output_tokens, 12);
        assert_eq!(entry.bucket_start_at, "2026-08-06T10:00:00Z");
        assert_eq!(entry.model.as_deref(), Some("pi-model"));
        assert!(!entry.sidechain);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The roster showed rows reading "Claude Code · <synthetic>": Claude Code
    /// stamps the entries it writes about itself with that placeholder, and
    /// one of them sitting above the first real assistant turn became the
    /// shift's model. The reader keeps looking past it.
    #[test]
    fn a_placeholder_model_is_skipped_for_the_first_real_one() {
        let dir = temp_dir("placeholder-model");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        write_transcript(
            &transcript,
            &[
                assistant_line("2026-08-06T10:14:00Z", "<synthetic>", false, 0, 0, 0, 0),
                assistant_line(
                    "2026-08-06T10:15:00Z",
                    "claude-opus-4.1",
                    false,
                    100,
                    20,
                    0,
                    0,
                ),
            ],
        );
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", None),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);

        let pending = spool::read_pending(&agent_path).expect("the spool reads");
        let heartbeat = pending
            .events
            .iter()
            .find(|event| event.event == AgentEventKind::Heartbeat)
            .expect("a model heartbeat is appended");
        assert_eq!(heartbeat.model.as_deref(), Some("claude-opus-4.1"));
    }

    /// A transcript that names nothing but placeholders records no model at
    /// all, which reads "not recorded" - never the placeholder itself.
    #[test]
    fn a_transcript_of_only_placeholders_names_no_model() {
        let dir = temp_dir("placeholder-only");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        write_transcript(
            &transcript,
            &[assistant_line(
                "2026-08-06T10:14:00Z",
                "<synthetic>",
                false,
                10,
                2,
                0,
                0,
            )],
        );
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", None),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);

        let pending = spool::read_pending(&agent_path).expect("the spool reads");
        assert!(
            !pending
                .events
                .iter()
                .any(|event| event.event == AgentEventKind::Heartbeat),
            "no model heartbeat rides a placeholder"
        );
    }

    #[test]
    fn the_first_model_the_transcript_names_rides_exactly_one_heartbeat() {
        let dir = temp_dir("heartbeat");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        write_transcript(
            &transcript,
            &[assistant_line(
                "2026-08-06T10:15:00Z",
                "claude-opus-4.1",
                false,
                100,
                20,
                0,
                0,
            )],
        );
        // Claude Code's hook payload names no model; the transcript does.
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", None),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);

        let pending = spool::read_pending(&agent_path).expect("the spool reads");
        let heartbeats: Vec<&SpoolEvent> = pending
            .events
            .iter()
            .filter(|event| event.event == AgentEventKind::Heartbeat)
            .collect();
        assert_eq!(heartbeats.len(), 1, "one model heartbeat is appended");
        let heartbeat = heartbeats[0];
        assert_eq!(heartbeat.model.as_deref(), Some("claude-opus-4.1"));
        assert_eq!(heartbeat.source, source());
        assert_eq!(heartbeat.external_session_id, "session-1");
        assert_eq!(heartbeat.cwd.as_deref(), Some("C:/dev/siqshift"));
        assert!(heartbeat.transcript_path.is_none() && heartbeat.tokens.is_none());
        assert!(
            read_registry(&usage_path)
                .sessions
                .values()
                .next()
                .expect("a session exists")
                .heartbeat_sent,
            "the emission is recorded"
        );

        // Later passes replay the spool (the heartbeat folds back in) and the
        // transcript, but no second heartbeat is ever emitted.
        capture_from_spool(&agent_path, &usage_path);
        let pending = spool::read_pending(&agent_path).expect("the spool reads");
        assert_eq!(
            pending
                .events
                .iter()
                .filter(|event| event.event == AgentEventKind::Heartbeat)
                .count(),
            1,
            "never twice for a session"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_hook_named_model_suppresses_the_heartbeat() {
        let dir = temp_dir("heartbeat-suppressed");
        let agent_path = dir.join("agent-spool.jsonl");
        let usage_path = dir.join("agent-usage.json");
        let transcript = dir.join("session-1.jsonl");
        write_transcript(
            &transcript,
            &[assistant_line(
                "2026-08-06T10:15:00Z",
                "claude-opus-4.1",
                false,
                100,
                20,
                0,
                0,
            )],
        );
        spool::append(
            &agent_path,
            &started_event(&transcript, "2026-08-06T10:00:00Z", Some("pi-model")),
        )
        .expect("append succeeds");

        capture_from_spool(&agent_path, &usage_path);

        let pending = spool::read_pending(&agent_path).expect("the spool reads");
        assert!(
            pending
                .events
                .iter()
                .all(|event| event.event != AgentEventKind::Heartbeat),
            "the hook already named a model, so no heartbeat fires"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every key in the persisted registry, walked recursively.
    fn collect_keys(value: &serde_json::Value, keys: &mut Vec<String>) {
        match value {
            serde_json::Value::Object(map) => {
                for (key, nested) in map {
                    keys.push(key.clone());
                    collect_keys(nested, keys);
                }
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    collect_keys(item, keys);
                }
            }
            _ => {}
        }
    }

    #[test]
    fn the_persisted_registry_has_no_field_capable_of_holding_message_text() {
        let mut registry = UsageRegistry::default();
        let key = session_key(&source(), "session-1");
        registry.sessions.insert(
            key,
            SessionUsage {
                source: source(),
                external_session_id: "session-1".to_string(),
                transcript_path: Some(
                    "C:/Users/alex/.claude/projects/x/session-1.jsonl".to_string(),
                ),
                cwd: Some("C:/dev/siqshift".to_string()),
                model_from_hook: true,
                heartbeat_sent: true,
                hook_buckets: vec![BucketTotals {
                    bucket_start_at: "2026-08-06T10:00:00Z".to_string(),
                    model: Some("claude-opus-4.1".to_string()),
                    sidechain: false,
                    tokens: TokenTotals {
                        input: 150,
                        output: 12,
                        cache_creation: 3,
                        cache_read: 4,
                    },
                }],
                files: HashMap::from([(
                    "C:/Users/alex/.claude/projects/x/session-1.jsonl".to_string(),
                    FileUsage {
                        offset: 4_096,
                        identity_ms: Some(1_786_000_000_000),
                        resync: false,
                        buckets: vec![BucketTotals {
                            bucket_start_at: "2026-08-06T10:00:00Z".to_string(),
                            model: Some("claude-opus-4.1".to_string()),
                            sidechain: true,
                            tokens: TokenTotals {
                                input: 40,
                                output: 8,
                                cache_creation: 2,
                                cache_read: 0,
                            },
                        }],
                    },
                )]),
            },
        );
        registry.entries.push(UsageEntry {
            client_id: "client-1".to_string(),
            source: source(),
            external_session_id: "session-1".to_string(),
            bucket_start_at: "2026-08-06T10:00:00Z".to_string(),
            model: Some("claude-opus-4.1".to_string()),
            sidechain: false,
            input_tokens: 150,
            output_tokens: 12,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
            synced: false,
            rejected: false,
        });

        let serialized = serde_json::to_value(&registry).expect("the registry serializes");
        let mut keys = Vec::new();
        collect_keys(&serialized, &mut keys);
        assert!(!keys.is_empty());
        for forbidden in [
            "prompt",
            "message",
            "content",
            "text",
            "body",
            "line",
            "tool",
            "toolCalls",
            "branch",
            "subject",
        ] {
            assert!(
                !keys.iter().any(|key| key == forbidden),
                "the registry must not carry a `{forbidden}` key; keys: {keys:?}"
            );
        }

        // And the round-trip survives: capture state is durable.
        let reparsed: UsageRegistry =
            serde_json::from_value(serialized).expect("the registry round-trips");
        assert_eq!(reparsed.entries.len(), 1);
        assert_eq!(reparsed.sessions.len(), 1);
    }
}
