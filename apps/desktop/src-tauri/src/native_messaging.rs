//! Chrome native-messaging framing: the browser's sanctioned stdio channel.
//!
//! Every message on the wire is a 4-byte little-endian length prefix followed
//! by that many bytes of UTF-8 JSON, in both directions. Clock-In caps a
//! message at 64 KB — Chrome's own ceiling is far higher, but a rule set is a
//! few hundred bytes per rule and a span verdict under two hundred, so
//! anything bigger is a bug or abuse. Oversize and truncated frames are
//! dropped, never fatal: the browser relaunches the host freely, and one bad
//! frame must not take the port down with it.

use std::io::{self, Read, Write};

/// The per-message cap, applied in both directions.
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;

const LENGTH_PREFIX_BYTES: usize = 4;

/// One frame off the wire.
#[derive(Debug, PartialEq, Eq)]
pub enum Frame {
    /// A complete message body within the cap. Not yet JSON-checked; that is
    /// the caller's job, and bad JSON is dropped there too.
    Message(Vec<u8>),
    /// An oversize or truncated frame, already discarded. The stream stands
    /// at the next length prefix (or at EOF after a truncation), so the read
    /// loop simply carries on.
    Dropped,
}

/// Reads one frame. `Ok(None)` is a clean EOF at a frame boundary — the
/// browser closed the port and the loop should exit. Only real I/O errors
/// surface as `Err`.
pub fn read_frame(reader: &mut impl Read, buffer: &mut Vec<u8>) -> io::Result<Option<Frame>> {
    let mut prefix = [0u8; LENGTH_PREFIX_BYTES];
    match reader.read_exact(&mut prefix) {
        Ok(()) => {}
        // Zero bytes or a partial prefix both mean nothing more is coming.
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }

    let length = u32::from_le_bytes(prefix) as usize;
    if length > MAX_MESSAGE_BYTES {
        // Drain the declared payload so the next read starts on a frame
        // boundary; if it truncates mid-drain the stream is at EOF anyway.
        discard(reader, length)?;
        return Ok(Some(Frame::Dropped));
    }

    buffer.clear();
    buffer.resize(length, 0);
    match reader.read_exact(buffer) {
        Ok(()) => Ok(Some(Frame::Message(std::mem::take(buffer)))),
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => Ok(Some(Frame::Dropped)),
        Err(error) => Err(error),
    }
}

/// Writes one message with its length prefix, refusing anything over the cap.
pub fn write_frame(writer: &mut impl Write, body: &[u8]) -> io::Result<()> {
    if body.len() > MAX_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "message exceeds the 64 KB native-messaging cap",
        ));
    }
    writer.write_all(&(body.len() as u32).to_le_bytes())?;
    writer.write_all(body)?;
    writer.flush()
}

/// Serializes and writes one JSON message.
pub fn write_json(writer: &mut impl Write, value: &serde_json::Value) -> io::Result<()> {
    let body = serde_json::to_vec(value).map_err(io::Error::other)?;
    write_frame(writer, &body)
}

/// Consumes `remaining` bytes, stopping early at EOF. Used to skip a frame
/// the cap rejects so the stream stays on frame boundaries.
fn discard(reader: &mut impl Read, mut remaining: usize) -> io::Result<()> {
    let mut scratch = [0u8; 8 * 1024];
    while remaining > 0 {
        let chunk = remaining.min(scratch.len());
        match reader.read(&mut scratch[..chunk]) {
            // EOF mid-frame: the frame is dropped either way.
            Ok(0) => return Ok(()),
            Ok(read) => remaining -= read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn framed(body: &[u8]) -> Vec<u8> {
        let mut bytes = (body.len() as u32).to_le_bytes().to_vec();
        bytes.extend_from_slice(body);
        bytes
    }

    /// Reads a byte stream to exhaustion, the way the host's loop does.
    fn collect_frames(bytes: &[u8]) -> Vec<Frame> {
        let mut reader = Cursor::new(bytes.to_vec());
        let mut buffer = Vec::new();
        let mut frames = Vec::new();
        while let Some(frame) = read_frame(&mut reader, &mut buffer).expect("the stream reads") {
            frames.push(frame);
        }
        frames
    }

    #[test]
    fn a_written_frame_reads_back_byte_for_byte() {
        let body = br#"{"type":"get-rules"}"#;
        let mut wire = Vec::new();
        write_frame(&mut wire, body).expect("the write succeeds");

        assert_eq!(collect_frames(&wire), vec![Frame::Message(body.to_vec())]);
    }

    #[test]
    fn a_json_message_round_trips() {
        let mut wire = Vec::new();
        write_json(
            &mut wire,
            &serde_json::json!({"type": "rules", "rules": []}),
        )
        .expect("the write succeeds");

        let frames = collect_frames(&wire);
        let [Frame::Message(body)] = frames.as_slice() else {
            panic!("exactly one message frame");
        };
        let value: serde_json::Value = serde_json::from_slice(body).expect("the body parses");
        assert_eq!(value["type"], "rules");
    }

    #[test]
    fn a_message_at_the_cap_passes_and_one_byte_over_is_dropped() {
        let at_cap = vec![b'x'; MAX_MESSAGE_BYTES];
        let over_cap = vec![b'y'; MAX_MESSAGE_BYTES + 1];
        let mut wire = framed(&over_cap);
        wire.extend_from_slice(&framed(&at_cap));

        assert_eq!(
            collect_frames(&wire),
            vec![Frame::Dropped, Frame::Message(at_cap)]
        );
    }

    #[test]
    fn an_oversize_frame_is_drained_so_the_next_frame_still_reads() {
        let over_cap = vec![b'y'; MAX_MESSAGE_BYTES * 3];
        let good = br#"{"type":"get-rules"}"#;
        let mut wire = framed(&over_cap);
        wire.extend_from_slice(&framed(good));

        assert_eq!(
            collect_frames(&wire),
            vec![Frame::Dropped, Frame::Message(good.to_vec())]
        );
    }

    #[test]
    fn a_truncated_frame_is_dropped_and_the_stream_ends_cleanly() {
        let good = br#"{"a":1}"#;
        let mut wire = framed(good);
        // A prefix promising a full-size payload, then a few bytes and EOF.
        wire.extend_from_slice(&(MAX_MESSAGE_BYTES as u32).to_le_bytes());
        wire.extend_from_slice(b"{\"partial");

        assert_eq!(
            collect_frames(&wire),
            vec![Frame::Message(good.to_vec()), Frame::Dropped]
        );
    }

    #[test]
    fn an_oversize_frame_that_truncates_mid_drain_is_still_just_dropped() {
        let mut wire = ((MAX_MESSAGE_BYTES * 4) as u32).to_le_bytes().to_vec();
        wire.extend_from_slice(b"short");

        assert_eq!(collect_frames(&wire), vec![Frame::Dropped]);
    }

    #[test]
    fn a_clean_eof_at_a_frame_boundary_ends_the_stream() {
        assert!(collect_frames(b"").is_empty());
        // A partial length prefix is EOF too: nothing more can arrive.
        assert!(collect_frames(&[1, 0]).is_empty());
    }

    #[test]
    fn writes_beyond_the_cap_are_refused() {
        let mut wire = Vec::new();
        let body = vec![b'x'; MAX_MESSAGE_BYTES + 1];

        let error = write_frame(&mut wire, &body).expect_err("over the cap is refused");

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(wire.is_empty());
    }
}
