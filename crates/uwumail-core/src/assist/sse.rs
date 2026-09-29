//! Streamed answers: `text/event-stream` (the UwUMail server's stream endpoint, OpenAI's and
//! Anthropic's streams) and newline-delimited JSON (servers that stream one JSON value per line).
//!
//! Chunks may break anywhere, inside a UTF-8 sequence or a CRLF too. Lines longer than
//! [`MAX_LINE`] and events larger than [`MAX_EVENT`] are dropped instead of growing without end.

use std::time::Duration;

use crate::error::{Error, Result};

/// The longest line kept while waiting for its end.
pub const MAX_LINE: usize = 256 * 1024;
/// The largest event (its `data` lines together).
pub const MAX_EVENT: usize = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    /// `event:`, or `message` when the event named none (and for NDJSON lines).
    pub event: String,
    pub data: String,
}

/// A `text/event-stream` parser after the WHATWG rules, which also takes NDJSON: a line that starts
/// with `{` or `[` is an event of its own.
#[derive(Default)]
pub struct SseParser {
    buffer: Vec<u8>,
    /// The line being read grew too long; skip up to its end.
    skipping: bool,
    /// The last chunk ended in CR: a LF at the start of the next belongs to it.
    after_cr: bool,
    event: String,
    data: String,
    has_data: bool,
    oversized: bool,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes the next chunk and hands out the events it completed.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        let mut out = Vec::new();
        let mut rest = chunk;
        if self.after_cr {
            self.after_cr = false;
            if let Some(stripped) = rest.strip_prefix(b"\n") {
                rest = stripped;
            }
        }
        while let Some(end) = rest.iter().position(|b| *b == b'\n' || *b == b'\r') {
            let (line, tail) = rest.split_at(end);
            self.take_bytes(line);
            let crlf = tail.starts_with(b"\r\n");
            if tail[0] == b'\r' && tail.len() == 1 {
                self.after_cr = true;
            }
            rest = &tail[if crlf { 2 } else { 1 }..];
            self.end_line(&mut out);
        }
        self.take_bytes(rest);
        out
    }

    /// The stream ended: a last line and event without their ends still count.
    pub fn finish(&mut self) -> Vec<SseEvent> {
        let mut out = Vec::new();
        if !self.buffer.is_empty() || self.skipping {
            self.end_line(&mut out);
        }
        self.dispatch(&mut out);
        out
    }

    fn take_bytes(&mut self, bytes: &[u8]) {
        if self.skipping {
            return;
        }
        if self.buffer.len() + bytes.len() > MAX_LINE {
            self.buffer.clear();
            self.skipping = true;
            return;
        }
        self.buffer.extend_from_slice(bytes);
    }

    fn end_line(&mut self, out: &mut Vec<SseEvent>) {
        let bytes = std::mem::take(&mut self.buffer);
        if std::mem::take(&mut self.skipping) {
            return;
        }
        let line = String::from_utf8_lossy(&bytes);
        self.line(&line, out);
    }

    fn line(&mut self, line: &str, out: &mut Vec<SseEvent>) {
        if line.is_empty() {
            self.dispatch(out);
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let trimmed = line.trim_start();
        if !self.has_data && (trimmed.starts_with('{') || trimmed.starts_with('[')) {
            out.push(SseEvent { event: "message".into(), data: trimmed.trim_end().to_string() });
            return;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => self.event = value.to_string(),
            "data" => {
                if self.data.len() + value.len() + 1 > MAX_EVENT {
                    self.oversized = true;
                } else {
                    if self.has_data {
                        self.data.push('\n');
                    }
                    self.data.push_str(value);
                }
                self.has_data = true;
            }
            _ => {}
        }
    }

    fn dispatch(&mut self, out: &mut Vec<SseEvent>) {
        let event = std::mem::take(&mut self.event);
        let data = std::mem::take(&mut self.data);
        let has_data = std::mem::take(&mut self.has_data);
        if std::mem::take(&mut self.oversized) || !has_data {
            return;
        }
        out.push(SseEvent { event: if event.is_empty() { "message".into() } else { event }, data });
    }
}

/// How long a stream may take.
#[derive(Debug, Clone, Copy)]
pub struct StreamLimits {
    /// Without a byte for this long, the answer is given up.
    pub idle: Duration,
    /// The whole answer.
    pub total: Duration,
    /// Bytes read at most.
    pub max_bytes: usize,
}

impl Default for StreamLimits {
    fn default() -> Self {
        Self { idle: Duration::from_secs(60), total: Duration::from_secs(180), max_bytes: 4 * 1024 * 1024 }
    }
}

/// Whether to go on reading after an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flow {
    Continue,
    Stop,
}

/// Reads a streamed answer into `on_event` until it ends, `on_event` says stop, or a limit is hit.
/// Dropping the future closes the connection, which stops the model.
pub async fn read_events(
    mut response: reqwest::Response,
    limits: StreamLimits,
    mut on_event: impl FnMut(SseEvent) -> Result<Flow>,
) -> Result<()> {
    let deadline = tokio::time::Instant::now() + limits.total;
    let mut parser = SseParser::new();
    let mut read = 0usize;
    loop {
        let wait = limits.idle.min(deadline.saturating_duration_since(tokio::time::Instant::now()));
        let chunk = match tokio::time::timeout(wait, response.chunk()).await {
            Ok(chunk) => chunk?,
            Err(_) => return Err(Error::assist("providerFailed", "The model took too long to answer.")),
        };
        let Some(chunk) = chunk else { break };
        read += chunk.len();
        if read > limits.max_bytes {
            return Err(Error::assist("providerFailed", "The answer was too long."));
        }
        for event in parser.push(&chunk) {
            if on_event(event)? == Flow::Stop {
                return Ok(());
            }
        }
    }
    for event in parser.finish() {
        if on_event(event)? == Flow::Stop {
            break;
        }
    }
    Ok(())
}

/// Reads a whole (not streamed) answer, refusing one larger than `max_bytes`, within `limits`.
pub async fn read_body(mut response: reqwest::Response, limits: StreamLimits) -> Result<Vec<u8>> {
    if response.content_length().is_some_and(|length| length > limits.max_bytes as u64) {
        return Err(Error::assist("providerFailed", "The answer was too long."));
    }
    let deadline = tokio::time::Instant::now() + limits.total;
    let mut body = Vec::new();
    loop {
        let wait = limits.idle.min(deadline.saturating_duration_since(tokio::time::Instant::now()));
        let chunk = match tokio::time::timeout(wait, response.chunk()).await {
            Ok(chunk) => chunk?,
            Err(_) => return Err(Error::assist("providerFailed", "The model took too long to answer.")),
        };
        let Some(chunk) = chunk else { break };
        if body.len() + chunk.len() > limits.max_bytes {
            return Err(Error::assist("providerFailed", "The answer was too long."));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(parts: &[&[u8]]) -> Vec<SseEvent> {
        let mut parser = SseParser::new();
        let mut out: Vec<SseEvent> = parts.iter().flat_map(|part| parser.push(part)).collect();
        out.extend(parser.finish());
        out
    }

    fn event(name: &str, data: &str) -> SseEvent {
        SseEvent { event: name.into(), data: data.into() }
    }

    #[test]
    fn named_events_comments_and_multi_line_data() {
        let events = all(&[b": ping\n\nevent: delta\ndata: {\"text\":\"Hal\"}\n\nevent: done\ndata: a\ndata: b\n\n"]);
        assert_eq!(events, vec![event("delta", "{\"text\":\"Hal\"}"), event("done", "a\nb")]);
    }

    #[test]
    fn chunks_break_anywhere_even_in_crlf_and_utf8() {
        let text = "data: Grüße\r\n\r\ndata: zwei\r\n\r\n".as_bytes();
        // Every split point, a two-byte "ü" and the CRLFs included.
        for cut in 0..text.len() {
            let (a, b) = text.split_at(cut);
            assert_eq!(all(&[a, b]), vec![event("message", "Grüße"), event("message", "zwei")], "cut at {cut}");
        }
    }

    #[test]
    fn a_last_event_without_blank_line_counts() {
        assert_eq!(all(&[b"event: done\ndata: {}"]), vec![event("done", "{}")]);
    }

    #[test]
    fn ndjson_lines_are_events_too() {
        let events = all(&[b"{\"message\":{\"content\":\"Hi\"}}\n{\"done\":true}"]);
        assert_eq!(events, vec![event("message", "{\"message\":{\"content\":\"Hi\"}}"), event("message", "{\"done\":true}")]);
    }

    #[test]
    fn overlong_lines_are_dropped_and_reading_goes_on() {
        let long = format!("data: {}\n\ndata: ok\n\n", "x".repeat(MAX_LINE + 10));
        assert_eq!(all(&[long.as_bytes()]), vec![event("message", "ok")]);
    }

    #[test]
    fn oversized_events_are_dropped() {
        let line = format!("data: {}\n", "y".repeat(200 * 1024));
        let mut text = line.repeat(3);
        text.push_str("\ndata: next\n\n");
        assert_eq!(all(&[text.as_bytes()]), vec![event("message", "next")]);
    }
}
