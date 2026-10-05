//! Texts of new-mail notifications. Sender names and subjects are written by whoever sent the
//! mail, and a notification shows them outside the app, where nothing isolates them: direction
//! marks could turn them around, invisible characters hide a part, line breaks push text out of
//! view (webmail security review, push notifications; W-21 in the reader).

/// The longest sender name a notification shows.
pub const MAX_NAME: usize = 80;
/// The longest line of text (subject or snippet) a notification shows.
pub const MAX_LINE: usize = 200;

/// `text` on one line, without direction marks, invisible spaces and control characters, and cut
/// to `max` characters (with "…" when cut). The zero-width joiner stays: emoji need it.
pub fn notification_text(text: &str, max: usize) -> String {
    let mut plain = String::with_capacity(text.len().min(max * 4));
    let mut space = false;
    for c in text.chars() {
        if is_hidden(c) {
            continue;
        }
        if c.is_whitespace() || c.is_control() {
            space = !plain.is_empty();
            continue;
        }
        if space {
            plain.push(' ');
            space = false;
        }
        plain.push(c);
    }
    if plain.chars().count() <= max {
        return plain;
    }
    let mut cut: String = plain.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// Direction marks, isolates and invisible spaces.
fn is_hidden(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{200B}'
            | '\u{200C}'
            | '\u{200E}'
            | '\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

/// A sender as a notification names it: the name, else the address.
pub fn notification_sender(name: Option<&str>, email: &str) -> String {
    let name = notification_text(name.unwrap_or_default(), MAX_NAME);
    if name.is_empty() { notification_text(email, MAX_NAME) } else { name }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_names_plain_and_short() {
        assert_eq!(notification_text("  Mini\u{202E}knab  ", MAX_NAME), "Miniknab");
        assert_eq!(notification_text("Bank\u{200B}\u{2066}Support\u{2069}", MAX_NAME), "BankSupport");
        assert_eq!(notification_text("Line one\r\n\tline two\u{2028}three", MAX_LINE), "Line one line two three");
        assert_eq!(notification_text("a\u{0}b", MAX_NAME), "a b");
        // Emoji keep their joiner.
        assert_eq!(notification_text("👩\u{200D}💻 Leni", MAX_NAME), "👩\u{200D}💻 Leni");
        let long = "ä".repeat(MAX_NAME + 5);
        let cut = notification_text(&long, MAX_NAME);
        assert_eq!(cut.chars().count(), MAX_NAME);
        assert!(cut.ends_with('…'));
        assert_eq!(notification_text("\u{202E}\u{200B}", MAX_NAME), "");
    }

    #[test]
    fn names_the_sender_by_address_without_a_name() {
        assert_eq!(notification_sender(Some("Leni"), "leni@example.org"), "Leni");
        assert_eq!(notification_sender(Some(" \u{202E} "), "leni@example.org"), "leni@example.org");
        assert_eq!(notification_sender(None, "leni@example.org"), "leni@example.org");
    }
}
