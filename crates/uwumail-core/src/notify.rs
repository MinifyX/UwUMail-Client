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

/// How new-mail notifications read on the desktop and on iOS (Android keeps its own copy in
/// Kotlin, which also runs while no window is open). Set by the page from its settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotifyPrefs {
    /// Sender and subject, or only that new mail came (the webmail's "Show sender and subject").
    pub show_content: bool,
    /// The title without content, in the page's language: "New mail".
    pub new_mail: String,
    /// The text without content: "Open UwUMail to read it."
    pub hidden: String,
}

impl Default for NotifyPrefs {
    fn default() -> Self {
        Self { show_content: true, new_mail: "New mail".into(), hidden: "Open UwUMail to read it.".into() }
    }
}

impl NotifyPrefs {
    /// Takes the page's texts as plain, short lines; an empty one keeps the default.
    pub fn new(show_content: bool, new_mail: &str, hidden: &str) -> Self {
        let fallback = Self::default();
        let line = |text: &str, fallback: String| {
            let plain = notification_text(text, MAX_LINE);
            if plain.is_empty() { fallback } else { plain }
        };
        Self { show_content, new_mail: line(new_mail, fallback.new_mail), hidden: line(hidden, fallback.hidden) }
    }
}

/// One new mail as a notification needs it.
pub struct NotifiedMail<'a> {
    pub name: Option<&'a str>,
    pub email: &'a str,
    pub subject: &'a str,
    pub snippet: &'a str,
}

/// Title and text of the notification for new mail; `None` for none.
pub fn mail_notification(prefs: &NotifyPrefs, mails: &[NotifiedMail<'_>]) -> Option<(String, String)> {
    match mails {
        [] => None,
        _ if !prefs.show_content => Some((prefs.new_mail.clone(), prefs.hidden.clone())),
        [one] => Some((
            notification_sender(one.name, one.email),
            notification_text(if one.subject.trim().is_empty() { one.snippet } else { one.subject }, MAX_LINE),
        )),
        many => Some(("UwUMail".to_string(), format!("{} ✉︎", many.len()))),
    }
}

/// Escapes `&`, `<`, `>`, `"` and `'` for notification servers that read the text as markup.
/// Freedesktop servers with `body-markup` / `body-hyperlinks` (GNOME, KDE, dunst, mako, …) would
/// otherwise turn a stranger's subject into formatting or a clickable link that skips the app's
/// link check (security review 0.10 NT-1). Use it on Linux only: Windows and macOS show text
/// literally and would show `&amp;`.
pub fn markup_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markup_is_escaped_for_notification_servers() {
        assert_eq!(
            markup_escape("Tom & Jerry <a href=\"https://phish.invalid\">Rechnung</a> it's"),
            "Tom &amp; Jerry &lt;a href=&quot;https://phish.invalid&quot;&gt;Rechnung&lt;/a&gt; it&#39;s"
        );
        assert_eq!(markup_escape("&amp;"), "&amp;amp;", "already escaped text stays literal");
        assert_eq!(markup_escape("Grüße 👩\u{200D}💻"), "Grüße 👩\u{200D}💻");
    }

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

    #[test]
    fn hides_sender_and_subject_when_asked() {
        let mail = NotifiedMail { name: Some("Leni"), email: "leni@example.org", subject: "Hi", snippet: "" };
        let shown = NotifyPrefs::default();
        assert_eq!(mail_notification(&shown, &[]), None);
        assert_eq!(mail_notification(&shown, std::slice::from_ref(&mail)), Some(("Leni".into(), "Hi".into())));
        let hidden = NotifyPrefs::new(false, "Neue Mail", "Öffne UwUMail,\num sie zu lesen.");
        assert_eq!(
            mail_notification(&hidden, &[mail]),
            Some(("Neue Mail".into(), "Öffne UwUMail, um sie zu lesen.".into()))
        );
        // Empty texts from the page keep the defaults.
        assert_eq!(
            NotifyPrefs::new(false, " ", "\u{202E}"),
            NotifyPrefs { show_content: false, ..NotifyPrefs::default() }
        );
    }
}
