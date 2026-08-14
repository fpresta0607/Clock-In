//! `clock-in-browser-host`: the native-messaging host the browser extension
//! connects to. A thin dispatcher — read a framed JSON message from stdin,
//! touch the shared browser state files or the browser spool, and write one
//! framed JSON reply to stdout. All the file logic lives in the library's
//! `browser` and `spool` modules; this binary only maps the extension's
//! message types onto those calls, so the host and the app can never disagree
//! about where a span or a rule lives. It holds no credentials and opens no
//! sockets; a malformed frame is dropped and the loop carries on, because a
//! bad message must not take the port down with it.

use std::io::{self, BufWriter};
use std::path::Path;

use chrono::DateTime;
use clock_in_desktop_lib::browser::{
    self, ExtensionNamespaceCapacity, ExtensionNamespaceReservationAcknowledgement, TallyEntry,
};
use clock_in_desktop_lib::native_messaging::{self, Frame};
use clock_in_desktop_lib::spool::{self, AgentEventKind, SpoolEvent};
use serde_json::{json, Map, Value};

fn main() {
    let dir = spool::browser_dir();
    // The handshake marker is how the app reports "a browser is connected";
    // rewrite it on every host launch so a stale marker cannot outlive a
    // relaunch.
    browser::record_handshake(&dir);

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = BufWriter::new(stdout.lock());
    let mut buffer = Vec::new();

    loop {
        let frame = match native_messaging::read_frame(&mut reader, &mut buffer) {
            Ok(Some(frame)) => frame,
            Ok(None) => break, // the browser closed the port
            Err(_) => break,
        };
        let Frame::Message(body) = frame else {
            continue;
        };
        let Ok(message) = serde_json::from_slice::<Value>(&body) else {
            continue;
        };
        let Some(response) = handle(&dir, &message) else {
            continue;
        };
        if native_messaging::write_json(&mut writer, &response).is_err() {
            break;
        }
    }
}

/// Maps one extension message onto the library calls and, where the protocol
/// answers, returns the reply frame. `None` means "no reply" — either the
/// message was a one-way notification or it was malformed and dropped.
fn handle(dir: &Path, message: &Value) -> Option<Value> {
    let kind = message.get("type")?.as_str()?;
    match kind {
        "get-rules" => {
            let mut fields = collection_fields(dir);
            fields.insert("type".into(), json!("rules"));
            fields.insert("rules".into(), json!(read_rules(dir)));
            Some(Value::Object(fields))
        }
        "get-collection-state" => {
            let mut fields = collection_fields(dir);
            fields.insert("type".into(), json!("collection-state"));
            Some(Value::Object(fields))
        }
        "span-event" => span_reply(dir, message),
        "tally" => {
            record_tally(dir, message);
            None
        }
        "capture-paused" => {
            if let Some(collection_id) = message.get("collectionId").and_then(Value::as_str) {
                let _ = browser::record_capture_paused(dir, collection_id);
            }
            None
        }
        "namespace-capacity" => {
            record_namespace_capacity(dir, message);
            None
        }
        "namespace-reservation" => {
            acknowledge_reservation(dir, message);
            None
        }
        _ => None,
    }
}

/// The fields shared by both collection responses, exactly as the extension's
/// `collectionDetails` / `applyCapturePause` / `applyNamespaceReservation` read
/// them: camelCase keys, `null` when there is no admitted collection, and the
/// pending namespace reservation only while one is outstanding.
fn collection_fields(dir: &Path) -> Map<String, Value> {
    let id = browser::admitted_collection_id(dir);
    let namespace = browser::admitted_collection_namespace(dir);
    let mut fields = Map::new();
    fields.insert(
        "collectionEnabled".into(),
        json!(id.is_some() && namespace.is_some()),
    );
    fields.insert("collectionId".into(), json!(id));
    fields.insert("collectionNamespace".into(), json!(namespace));
    fields.insert(
        "capturePaused".into(),
        json!(browser::capture_is_paused(dir)),
    );
    if let Some(reservation) = browser::pending_extension_namespace_reservation(dir) {
        fields.insert(
            "namespaceReservation".into(),
            serde_json::to_value(reservation).unwrap_or(Value::Null),
        );
    }
    fields
}

/// The URL rules the app wrote, served verbatim so the extension matches tabs
/// locally. `{ "rules": [...] }` on disk becomes the `rules` array on the wire;
/// a missing or corrupt file is an empty rule set, never an error.
fn read_rules(dir: &Path) -> Vec<Value> {
    let path = dir.join("browser-rules.json");
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return Vec::new();
    };
    value
        .get("rules")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn is_canonical_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b[8] == b'-'
        && b[13] == b'-'
        && b[18] == b'-'
        && b[23] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, &byte)| matches!(i, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit())
}

fn is_strict_rfc3339(s: &str) -> bool {
    if DateTime::parse_from_rfc3339(s).is_err() {
        return false;
    }
    let b = s.as_bytes();
    if !s.is_ascii() || b.get(10) != Some(&b'T') || s.ends_with('z') {
        return false;
    }
    if b.get(17) == Some(&b'6') && b.get(18) == Some(&b'0') {
        return false;
    }
    true
}

/// A span verdict: append it to the browser spool and acknowledge. A verdict
/// for a collection the app no longer admits is answered with `span-retry`,
/// which makes the extension reconnect and re-sync its collection state rather
/// than silently dropping the span.
fn span_reply(dir: &Path, message: &Value) -> Option<Value> {
    let collection_id = message.get("collectionId")?.as_str()?;
    let event = message.get("event")?;
    let kind = match event.get("event")?.as_str()? {
        "started" => AgentEventKind::Started,
        "ended" => AgentEventKind::Ended,
        "heartbeat" => AgentEventKind::Heartbeat,
        _ => return None,
    };
    let external_session_id = event.get("externalSessionId")?.as_str()?;
    let rule_id = event.get("ruleId")?.as_str()?;
    let occurred_at = event.get("occurredAt")?.as_str()?;
    if external_session_id.is_empty()
        || external_session_id.len() > 200
        || !is_canonical_uuid(rule_id)
        || !is_strict_rfc3339(occurred_at)
    {
        return None;
    }

    let admitted = browser::admitted_collection_id(dir).as_deref() == Some(collection_id);
    let reply_type = if !admitted {
        "span-retry"
    } else {
        let span = SpoolEvent {
            source: spool::AgentSource::browser(),
            external_session_id: external_session_id.to_string(),
            event: kind,
            occurred_at: occurred_at.to_string(),
            cwd: None,
            model: None,
            rule_id: Some(rule_id.to_string()),
        };
        match spool::append(&dir.join("browser-spool.jsonl"), &span) {
            Ok(()) => "span-ack",
            Err(_) => "span-retry",
        }
    };
    Some(json!({ "type": reply_type, "collectionId": collection_id, "event": event }))
}

fn record_tally(dir: &Path, message: &Value) {
    let Some(collection_id) = message.get("collectionId").and_then(Value::as_str) else {
        return;
    };
    let Some(week_start) = message.get("weekStart").and_then(Value::as_u64) else {
        return;
    };
    let Ok(entries) = serde_json::from_value::<Vec<TallyEntry>>(
        message.get("entries").cloned().unwrap_or(Value::Null),
    ) else {
        return;
    };
    let _ = browser::record_tally(dir, collection_id, week_start, &entries);
}

fn record_namespace_capacity(dir: &Path, message: &Value) {
    let Some(collection_id) = message.get("collectionId").and_then(Value::as_str) else {
        return;
    };
    let Ok(namespaces) = serde_json::from_value::<Vec<ExtensionNamespaceCapacity>>(
        message.get("namespaces").cloned().unwrap_or(Value::Null),
    ) else {
        return;
    };
    let _ = browser::record_extension_namespace_capacity(dir, collection_id, namespaces);
}

fn acknowledge_reservation(dir: &Path, message: &Value) {
    let Some(request_id) = message.get("requestId").and_then(Value::as_str) else {
        return;
    };
    let Ok(acknowledgement) = serde_json::from_value::<ExtensionNamespaceReservationAcknowledgement>(
        message
            .get("acknowledgement")
            .cloned()
            .unwrap_or(Value::Null),
    ) else {
        return;
    };
    let _ = browser::acknowledge_extension_namespace_reservation(dir, request_id, acknowledgement);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("the clock is past the epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "clock-in-browser-host-{name}-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("the temp dir is created");
        dir
    }

    #[test]
    fn read_rules_serves_the_rules_array_verbatim() {
        let dir = temp_dir("rules");
        std::fs::write(
            dir.join("browser-rules.json"),
            r#"{"rules":[{"id":"r1","pattern":"github.com/acme/*"}]}"#,
        )
        .expect("the rules file is written");

        assert_eq!(
            read_rules(&dir),
            vec![serde_json::json!({"id": "r1", "pattern": "github.com/acme/*"})]
        );
    }

    #[test]
    fn read_rules_treats_a_missing_or_corrupt_file_as_an_empty_rule_set() {
        let dir = temp_dir("empty");
        assert!(read_rules(&dir).is_empty());
        std::fs::write(dir.join("browser-rules.json"), "not json").expect("written");
        assert!(read_rules(&dir).is_empty());
    }

    #[test]
    fn collection_fields_report_disabled_without_an_admitted_collection() {
        let dir = temp_dir("collection");
        let fields = collection_fields(&dir);

        assert_eq!(fields.get("collectionEnabled"), Some(&json!(false)));
        assert_eq!(fields.get("collectionId"), Some(&Value::Null));
        assert_eq!(fields.get("collectionNamespace"), Some(&Value::Null));
        assert_eq!(fields.get("capturePaused"), Some(&json!(false)));
    }

    #[test]
    fn the_dispatcher_answers_get_rules_and_drops_unknown_types() {
        let dir = temp_dir("dispatch");

        let rules = handle(&dir, &json!({"type": "get-rules"}));
        assert_eq!(
            rules.as_ref().and_then(|value| value.get("type")),
            Some(&json!("rules"))
        );
        assert_eq!(
            rules.as_ref().and_then(|value| value.get("rules")),
            Some(&json!([]))
        );

        assert!(handle(&dir, &json!({"type": "no-such-message"})).is_none());
        assert!(handle(&dir, &json!({"no type": true})).is_none());
    }

    #[test]
    fn a_span_for_an_unadmitted_collection_is_retried_not_dropped() {
        let dir = temp_dir("span");

        let reply = span_reply(
            &dir,
            &json!({
                "type": "span-event",
                "collectionId": "some-collection",
                "event": {
                    "event": "started",
                    "externalSessionId": "s1",
                    "ruleId": "00000000-0000-0000-0000-000000000001",
                    "occurredAt": "2026-08-06T13:30:00.000Z"
                },
            }),
        );

        assert_eq!(
            reply.as_ref().and_then(|value| value.get("type")),
            Some(&json!("span-retry"))
        );
        assert_eq!(
            reply.as_ref().and_then(|value| value.get("collectionId")),
            Some(&json!("some-collection"))
        );
    }

    #[test]
    fn malformed_span_fields_are_dropped() {
        let dir = temp_dir("span-validate");

        let reply_for = |rule_id: &str, occurred_at: &str| {
            span_reply(
                &dir,
                &json!({
                    "type": "span-event",
                    "collectionId": "some-collection",
                    "event": {
                        "event": "started",
                        "externalSessionId": "s1",
                        "ruleId": rule_id,
                        "occurredAt": occurred_at,
                    },
                }),
            )
        };

        assert!(reply_for(
            "00000000-0000-0000-0000-000000000001",
            "2026-08-06T13:30:00.000Z"
        )
        .is_some());
        assert!(reply_for(
            "00000000000000000000000000000001",
            "2026-08-06T13:30:00.000Z"
        )
        .is_none());
        assert!(reply_for(
            "urn:uuid:00000000-0000-0000-0000-000000000001",
            "2026-08-06T13:30:00.000Z"
        )
        .is_none());
        assert!(reply_for(
            "{00000000-0000-0000-0000-000000000001}",
            "2026-08-06T13:30:00.000Z"
        )
        .is_none());
        assert!(reply_for(
            "00000000-0000-0000-0000-000000000001",
            "2026-08-06 13:30:00+00:00"
        )
        .is_none());
        assert!(reply_for(
            "00000000-0000-0000-0000-000000000001",
            "2026-08-06t13:30:00Z"
        )
        .is_none());
        assert!(reply_for(
            "00000000-0000-0000-0000-000000000001",
            "2026-08-06T13:30:00z"
        )
        .is_none());
        assert!(reply_for(
            "00000000-0000-0000-0000-000000000001",
            "2026-08-06T23:59:60Z"
        )
        .is_none());
        assert!(reply_for(
            "00000000-0000-0000-0000-000000000001",
            "2026-08-06T13:30:00\u{2212}05:00"
        )
        .is_none());
    }
}
