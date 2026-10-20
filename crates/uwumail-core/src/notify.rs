//! Texts of new-mail notifications. Sender names and subjects are written by whoever sent the
//! mail, and a notification shows them outside the app, where nothing isolates them: direction
//! marks could turn them around, invisible characters hide a part, line breaks push text out of
//! view (webmail security review, push notifications; W-21 in the reader).

/// The longest sender name a notification shows.
pub const MAX_NAME: usize = 80;
/// The longest line of text (subject or snippet) a notification shows.
pub const MAX_LINE: usize = 200;

fn is_noncharacter(c: char) -> bool {
    let c = c as u32;
    (0xFDD0..=0xFDEF).contains(&c) || c & 0xFFFE == 0xFFFE
}

/// `text` on one line, without direction marks, invisible spaces and control characters, and cut
/// to `max` characters (with "…" when cut). The zero-width joiner stays: emoji need it.
pub fn notification_text(text: &str, max: usize) -> String {
    let mut plain = String::with_capacity(text.len().min(max * 4));
    let mut space = false;
    for c in text.chars() {
        // Noncharacters (U+FFFE, U+FFFF, …) aren't allowed in XML, so a Windows toast with one
        // wouldn't load.
        if is_hidden(c) || is_noncharacter(c) {
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
    /// The title for two or more mails, `{n}` standing for how many: "{n} new mails".
    pub many: String,
    /// Accounts (by id) whose mail doesn't notify.
    pub muted: Vec<String>,
    /// When no mail notifies.
    pub quiet: Option<QuietHours>,
}

/// The longest list of muted accounts the prefs keep.
pub const MAX_MUTED: usize = 256;
/// The longest account id the muted list keeps.
pub const MAX_MUTED_ID: usize = 128;

/// Times of the week without notifications: from `from` to `to` (minutes after midnight, local
/// time) on the listed days. A span past midnight belongs to the day it starts on; `from == to`
/// means the whole day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuietHours {
    pub from: u16,
    pub to: u16,
    /// Bit `d` set: day `d` (0 = Sunday) is quiet.
    pub days: u8,
}

impl QuietHours {
    /// From the settings' form: "HH:MM" times and days 0–6 (0 = Sunday). `None` for anything else.
    pub fn parse(from: &str, to: &str, days: &[u64]) -> Option<Self> {
        let mut mask = 0u8;
        for &day in days {
            if day > 6 {
                return None;
            }
            mask |= 1 << day;
        }
        Some(Self { from: parse_time(from)?, to: parse_time(to)?, days: mask })
    }

    /// From the settings' JSON, `{"from":"HH:MM","to":"HH:MM","days":[0-6]}`; `None` for anything
    /// else (other fields, like `enabled`, are the caller's).
    pub fn from_value(value: &serde_json::Value) -> Option<Self> {
        let days: Option<Vec<u64>> = value.get("days")?.as_array()?.iter().map(serde_json::Value::as_u64).collect();
        Self::parse(value.get("from")?.as_str()?, value.get("to")?.as_str()?, &days?)
    }

    /// The settings' JSON form.
    pub fn to_value(&self) -> serde_json::Value {
        serde_json::json!({ "from": Self::time(self.from), "to": Self::time(self.to), "days": self.day_list() })
    }

    /// "HH:MM" of `minutes` after midnight.
    pub fn time(minutes: u16) -> String {
        format!("{:02}:{:02}", minutes / 60, minutes % 60)
    }

    /// The listed days, 0 = Sunday.
    pub fn day_list(&self) -> Vec<u8> {
        (0..7).filter(|day| self.days & (1 << day) != 0).collect()
    }

    /// Whether `minute` (after midnight) of `weekday` (0 = Sunday) is quiet.
    pub fn contains(&self, weekday: u8, minute: u16) -> bool {
        let listed = |day: u8| self.days & (1 << (day % 7)) != 0;
        let yesterday = (weekday + 6) % 7;
        match self.from.cmp(&self.to) {
            std::cmp::Ordering::Equal => listed(weekday),
            std::cmp::Ordering::Less => listed(weekday) && self.from <= minute && minute < self.to,
            std::cmp::Ordering::Greater => {
                (listed(weekday) && minute >= self.from) || (listed(yesterday) && minute < self.to)
            }
        }
    }
}

fn parse_time(text: &str) -> Option<u16> {
    let (hours, minutes) = text.split_once(':')?;
    if hours.len() != 2 || minutes.len() != 2 || !text.bytes().all(|b| b.is_ascii_digit() || b == b':') {
        return None;
    }
    let (hours, minutes) = (hours.parse::<u16>().ok()?, minutes.parse::<u16>().ok()?);
    (hours < 24 && minutes < 60).then_some(hours * 60 + minutes)
}

impl Default for NotifyPrefs {
    fn default() -> Self {
        Self {
            show_content: true,
            new_mail: "New mail".into(),
            hidden: "Open UwUMail to read it.".into(),
            many: "{n} new mails".into(),
            muted: Vec::new(),
            quiet: None,
        }
    }
}

impl NotifyPrefs {
    /// Takes the page's texts as plain, short lines; an empty one keeps the default, and so does a
    /// title for many mails that doesn't say how many.
    pub fn new(show_content: bool, new_mail: &str, hidden: &str, many: &str) -> Self {
        let fallback = Self::default();
        let line = |text: &str, fallback: String| {
            let plain = notification_text(text, MAX_LINE);
            if plain.is_empty() { fallback } else { plain }
        };
        let many = Some(line(many, fallback.many.clone())).filter(|many| many.contains("{n}")).unwrap_or(fallback.many);
        Self {
            show_content,
            new_mail: line(new_mail, fallback.new_mail),
            hidden: line(hidden, fallback.hidden),
            many,
            muted: Vec::new(),
            quiet: None,
        }
    }

    /// The same texts with muted accounts and quiet hours.
    pub fn with_filter(mut self, muted: Vec<String>, quiet: Option<QuietHours>) -> Self {
        let mut muted = muted;
        // Ids are short; the cap keeps the kept file (notification-prefs.json) well under its limit.
        muted.retain(|id| !id.is_empty() && id.len() <= MAX_MUTED_ID);
        muted.sort();
        muted.dedup();
        muted.truncate(MAX_MUTED);
        self.muted = muted;
        self.quiet = quiet;
        self
    }

    /// Whether new mail of `account_id` notifies at `minute` (after midnight) of `weekday`
    /// (0 = Sunday).
    pub fn rings(&self, account_id: &str, weekday: u8, minute: u16) -> bool {
        !self.muted.iter().any(|id| id == account_id)
            && !self.quiet.is_some_and(|quiet| quiet.contains(weekday, minute))
    }

    /// Whether new mail of `account_id` notifies now, in local time.
    pub fn rings_now(&self, account_id: &str) -> bool {
        use chrono::{Datelike, Timelike};
        let now = chrono::Local::now();
        let weekday = now.weekday().num_days_from_sunday() as u8;
        let minute = (now.hour() * 60 + now.minute()) as u16;
        self.rings(account_id, weekday, minute)
    }
}

/// One new mail as a notification needs it.
pub struct NotifiedMail<'a> {
    pub name: Option<&'a str>,
    pub email: &'a str,
    pub subject: &'a str,
    pub snippet: &'a str,
}

/// A mail as a notification names it: who sent it and what about, both plain and short.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailLine {
    pub sender: String,
    pub text: String,
}

impl MailLine {
    pub fn new(mail: &NotifiedMail<'_>) -> Self {
        let text = if mail.subject.trim().is_empty() { mail.snippet } else { mail.subject };
        Self { sender: notification_sender(mail.name, mail.email), text: notification_text(text, MAX_LINE) }
    }
}

/// How many mails a notification about several names, newest first; the rest it only counts.
pub const SHOWN_MAILS: usize = 2;

/// `mails` (oldest first) as a notification about them alone: how many, and the newest lines.
pub fn lines(mails: &[NotifiedMail<'_>]) -> (usize, Vec<MailLine>) {
    (mails.len(), mails.iter().rev().take(SHOWN_MAILS).map(MailLine::new).collect())
}

/// The mails notified since UwUMail was last looked at, per account. The desktop shows them as one
/// notification per account that every new mail replaces, so mail that came while the computer
/// was locked doesn't come back as a pile of notifications at once.
#[derive(Debug, Default)]
pub struct Unseen {
    accounts: std::collections::HashMap<String, (usize, Vec<MailLine>)>,
}

impl Unseen {
    /// Counts `mails` (oldest first) in for `account`: how many are unseen now, newest lines first.
    pub fn add(&mut self, account: &str, mails: &[NotifiedMail<'_>]) -> (usize, Vec<MailLine>) {
        let (count, newest) = self.accounts.entry(account.to_string()).or_default();
        *count += mails.len();
        let (_, mut added) = lines(mails);
        added.append(newest);
        added.truncate(SHOWN_MAILS);
        *newest = added;
        (*count, newest.clone())
    }

    /// UwUMail was looked at: the next mail starts a new notification.
    pub fn clear(&mut self) {
        self.accounts.clear();
    }
}

/// Title and text of the notification for `count` new mails, of which `newest` names the newest
/// (see [`SHOWN_MAILS`]); `None` for none. Several mails take one line each in the text.
pub fn mail_notification(prefs: &NotifyPrefs, count: usize, newest: &[MailLine]) -> Option<(String, String)> {
    match (count, newest) {
        (0, _) | (_, []) => None,
        (1, _) if !prefs.show_content => Some((prefs.new_mail.clone(), prefs.hidden.clone())),
        (1, [one, ..]) => Some((one.sender.clone(), one.text.clone())),
        _ => {
            let title = prefs.many.replace("{n}", &count.to_string());
            if !prefs.show_content {
                return Some((title, prefs.hidden.clone()));
            }
            let mut body: Vec<String> =
                newest.iter().take(SHOWN_MAILS).map(|mail| format!("{}: {}", mail.sender, mail.text)).collect();
            let rest = count.saturating_sub(body.len());
            if rest > 0
                && let Some(last) = body.last_mut()
            {
                last.push_str(&format!(" · +{rest}"));
            }
            Some((title, body.join("\n")))
        }
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
        let (count, newest) = lines(std::slice::from_ref(&mail));
        assert_eq!(mail_notification(&shown, 0, &[]), None);
        assert_eq!(mail_notification(&shown, count, &newest), Some(("Leni".into(), "Hi".into())));
        let hidden = NotifyPrefs::new(false, "Neue Mail", "Öffne UwUMail,\num sie zu lesen.", "{n} neue Mails");
        assert_eq!(
            mail_notification(&hidden, count, &newest),
            Some(("Neue Mail".into(), "Öffne UwUMail, um sie zu lesen.".into()))
        );
        assert_eq!(
            mail_notification(&hidden, 3, &newest),
            Some(("3 neue Mails".into(), "Öffne UwUMail, um sie zu lesen.".into()))
        );
        // Empty texts from the page keep the defaults, and so does a title that doesn't count.
        assert_eq!(
            NotifyPrefs::new(false, " ", "\u{202E}", "Viele Mails"),
            NotifyPrefs { show_content: false, ..NotifyPrefs::default() }
        );
    }

    #[test]
    fn drops_what_xml_doesnt_allow() {
        assert_eq!(notification_text("Re\u{FFFE}chnung\u{FFFF} \u{FDD0}da", 80), "Rechnung da");
    }

    #[test]
    fn an_empty_subject_falls_back_to_the_snippet() {
        let mail = NotifiedMail { name: None, email: "tom@example.org", subject: " ", snippet: "Hallo du" };
        assert_eq!(MailLine::new(&mail), MailLine { sender: "tom@example.org".into(), text: "Hallo du".into() });
    }

    #[test]
    fn mails_until_uwumail_is_looked_at_become_one_notification() {
        let prefs = NotifyPrefs::new(true, "Neue Mail", "Öffne UwUMail.", "{n} neue Mails");
        let mail = |name, subject| NotifiedMail { name: Some(name), email: "x@example.org", subject, snippet: "" };
        let mut unseen = Unseen::default();

        let (count, newest) = unseen.add("a", &[mail("Leni", "Hallo")]);
        assert_eq!(mail_notification(&prefs, count, &newest), Some(("Leni".into(), "Hallo".into())));

        let (count, newest) = unseen.add("a", &[mail("Tom", "Rechnung")]);
        assert_eq!(
            mail_notification(&prefs, count, &newest),
            Some(("2 neue Mails".into(), "Tom: Rechnung\nLeni: Hallo".into()))
        );

        // Several at once, oldest first: the newest two are named, the rest counted.
        let (count, newest) = unseen.add("a", &[mail("Kim", "Termin"), mail("Jo", "Fotos")]);
        assert_eq!(
            mail_notification(&prefs, count, &newest),
            Some(("4 neue Mails".into(), "Jo: Fotos\nKim: Termin · +2".into()))
        );

        // Every account on its own.
        assert_eq!(unseen.add("b", &[mail("Ana", "Hi")]).0, 1);

        unseen.clear();
        let (count, newest) = unseen.add("a", &[mail("Leni", "Noch was")]);
        assert_eq!(mail_notification(&prefs, count, &newest), Some(("Leni".into(), "Noch was".into())));
    }

    #[test]
    fn quiet_hours_parse_only_the_settings_form() {
        let quiet = QuietHours::parse("22:00", "07:30", &[0, 6]).unwrap();
        assert_eq!((quiet.from, quiet.to, quiet.day_list()), (22 * 60, 7 * 60 + 30, vec![0, 6]));
        assert_eq!(QuietHours::time(quiet.to), "07:30");
        for (from, to) in [("24:00", "07:00"), ("7:00", "08:00"), ("07:60", "08:00"), ("+1:00", "08:00"), ("", "08:00")]
        {
            assert!(QuietHours::parse(from, to, &[1]).is_none(), "{from}");
        }
        assert!(QuietHours::parse("07:00", "08:00", &[7]).is_none());
        assert_eq!(QuietHours::from_value(&quiet.to_value()), Some(quiet));
        assert!(QuietHours::from_value(&serde_json::json!({"from": "22:00", "to": "07:00", "days": [-1]})).is_none());
    }

    #[test]
    fn quiet_hours_within_a_day() {
        let quiet = QuietHours::parse("12:00", "13:00", &[1]).unwrap();
        assert!(quiet.contains(1, 12 * 60));
        assert!(quiet.contains(1, 12 * 60 + 59));
        assert!(!quiet.contains(1, 13 * 60));
        assert!(!quiet.contains(1, 11 * 60 + 59));
        assert!(!quiet.contains(2, 12 * 60 + 30));
    }

    #[test]
    fn quiet_hours_past_midnight_belong_to_the_day_they_start() {
        // Friday night until Saturday morning.
        let quiet = QuietHours::parse("22:00", "07:00", &[5]).unwrap();
        assert!(quiet.contains(5, 23 * 60));
        assert!(quiet.contains(6, 6 * 60 + 59));
        assert!(!quiet.contains(6, 7 * 60));
        assert!(!quiet.contains(5, 6 * 60));
        assert!(!quiet.contains(6, 23 * 60));
        // Saturday night runs into Sunday (day 0).
        let quiet = QuietHours::parse("22:00", "07:00", &[6]).unwrap();
        assert!(quiet.contains(0, 60));
        // The same start and end mean the whole day.
        let quiet = QuietHours::parse("00:00", "00:00", &[3]).unwrap();
        assert!(quiet.contains(3, 0) && quiet.contains(3, 24 * 60 - 1) && !quiet.contains(4, 0));
    }

    #[test]
    fn muted_accounts_and_quiet_hours_keep_mail_silent() {
        let quiet = QuietHours::parse("22:00", "07:00", &[0, 1, 2, 3, 4, 5, 6]);
        let prefs = NotifyPrefs::default().with_filter(vec!["b".into(), "a".into(), "a".into(), String::new()], quiet);
        assert_eq!(prefs.muted, ["a", "b"]);
        assert!(!prefs.rings("a", 1, 12 * 60));
        assert!(prefs.rings("c", 1, 12 * 60));
        assert!(!prefs.rings("c", 1, 23 * 60));
        assert!(NotifyPrefs::default().rings("a", 1, 23 * 60));
    }

    #[test]
    fn muted_list_stays_small() {
        let ids = (0..MAX_MUTED * 2).map(|i| format!("{i:0>width$}", width = MAX_MUTED_ID + 1)).collect();
        assert!(NotifyPrefs::default().with_filter(ids, None).muted.is_empty(), "overlong ids are dropped");
        let ids = (0..MAX_MUTED * 2).map(|i| format!("{i:0>width$}", width = MAX_MUTED_ID)).collect();
        let prefs = NotifyPrefs::default().with_filter(ids, None);
        assert_eq!(prefs.muted.len(), MAX_MUTED);
        // The whole list fits the file the desktop app keeps (64 KiB).
        assert!(serde_json::to_vec(&prefs.muted).unwrap().len() < 48 * 1024);
    }
}
