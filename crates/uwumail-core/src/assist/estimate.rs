//! What a call to the assistant would take, before it is made: the tooltip on its buttons.
//!
//! A UwUMail account asks its server (`Assist/estimate`, docs/jmap-assist.md of UwUMail Server);
//! every other mailbox counts here, with the same prompt the real call would send and the same
//! rough count as the server: about four characters to a token, a token for each character of
//! Chinese, Japanese or Korean. The answer is expected to be about as long as a typical one of its
//! kind, never more than the call allows the model.

use serde_json::Value;

use super::prompts::Prompt;

/// Typical answers, in tokens: a mail written from an instruction, a summary of one mail (and what
/// each further mail of a conversation adds), a spam verdict with its reasons, and a mail's events.
/// The same numbers as UwUMail Server's.
pub const TYPICAL_WRITE_TOKENS: u64 = 400;
pub const TYPICAL_SUMMARY_TOKENS: u64 = 150;
pub const TYPICAL_SUMMARY_TOKENS_PER_MAIL: u64 = 50;
pub const TYPICAL_SUMMARY_MAX_TOKENS: u64 = 600;
pub const TYPICAL_SPAM_TOKENS: u64 = 150;
pub const TYPICAL_EVENTS_TOKENS: u64 = 250;
/// A rewritten or adjusted draft is about as long as the draft, and at least this.
pub const MIN_REWRITE_TOKENS: u64 = 100;
/// What a picture that was never read counts: a short poster or ticket.
pub const UNREAD_PICTURE_CHARS: usize = 400;

/// The calls that can be estimated, as the server names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Compose,
    Summarize,
    SpamCheck,
    ExtractEvents,
}

impl Method {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "Assist/compose" => Some(Self::Compose),
            "Assist/summarize" => Some(Self::Summarize),
            "Assist/spamCheck" => Some(Self::SpamCheck),
            "Assist/extractEvents" => Some(Self::ExtractEvents),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Compose => "Assist/compose",
            Self::Summarize => "Assist/summarize",
            Self::SpamCheck => "Assist/spamCheck",
            Self::ExtractEvents => "Assist/extractEvents",
        }
    }

    pub fn feature(self) -> super::Feature {
        match self {
            Self::Compose => super::Feature::Compose,
            Self::Summarize => super::Feature::Summarize,
            Self::SpamCheck => super::Feature::SpamCheck,
            Self::ExtractEvents => super::Feature::ExtractEvents,
        }
    }
}

/// Chinese, Japanese and Korean script: about a token per character.
fn is_wide(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x11FF         // Hangul Jamo
        | 0x2E80..=0x2FDF       // CJK radicals
        | 0x3040..=0x30FF       // Hiragana, Katakana
        | 0x3100..=0x312F       // Bopomofo
        | 0x3130..=0x318F       // Hangul compatibility Jamo
        | 0x31F0..=0x31FF       // Katakana extensions
        | 0x3400..=0x4DBF       // CJK extension A
        | 0x4E00..=0x9FFF       // CJK unified ideographs
        | 0xAC00..=0xD7AF       // Hangul syllables
        | 0xF900..=0xFAFF       // CJK compatibility ideographs
        | 0xFF66..=0xFF9F       // half-width Katakana
        | 0x20000..=0x3134F // CJK extensions B to G
    )
}

/// Tokens of some texts together, roughly.
pub fn tokens<'a>(texts: impl IntoIterator<Item = &'a str>) -> u64 {
    let (mut wide, mut other) = (0u64, 0u64);
    for text in texts {
        for c in text.chars() {
            if is_wide(c) {
                wide += 1;
            } else {
                other += 1;
            }
        }
    }
    wide + other.div_ceil(4)
}

/// Tokens of a prompt: its instructions, the data and the answer's JSON shape, which goes along too.
pub fn prompt_tokens(prompt: &Prompt) -> u64 {
    let schema = prompt.schema.as_ref().map(|(_, schema)| schema.to_string()).unwrap_or_default();
    tokens([prompt.system.as_str(), prompt.user.as_str(), schema.as_str()])
}

/// The expected answer of a call.
pub enum Answer<'a> {
    /// `write`: a new mail.
    Write,
    /// `rewrite` or `adjust`: the draft, changed.
    Rewrite {
        text: &'a str,
    },
    /// A summary of this many mails.
    Summary {
        mails: usize,
    },
    SpamCheck,
    Events,
}

/// The answer's size in tokens, at most what the prompt allows the model.
pub fn output_tokens(answer: Answer<'_>, prompt: &Prompt) -> u64 {
    let typical = match answer {
        Answer::Write => TYPICAL_WRITE_TOKENS,
        Answer::Rewrite { text } => tokens([text]).max(MIN_REWRITE_TOKENS),
        Answer::Summary { mails } => (TYPICAL_SUMMARY_TOKENS
            + TYPICAL_SUMMARY_TOKENS_PER_MAIL * mails.saturating_sub(1) as u64)
            .min(TYPICAL_SUMMARY_MAX_TOKENS),
        Answer::SpamCheck => TYPICAL_SPAM_TOKENS,
        Answer::Events => TYPICAL_EVENTS_TOKENS,
    };
    typical.min(u64::from(prompt.max_tokens))
}

/// Picture text for an estimate: what was read already, else a guess per picture, so hovering a
/// button never reads pictures.
pub fn unread_pictures(count: usize) -> Vec<String> {
    (0..count.min(20)).map(|_| "x".repeat(UNREAD_PICTURE_CHARS)).collect()
}

/// An estimate as the page gets it, in the shape of the server's `Assist/estimate` response.
pub fn answer_json(
    method: Method,
    input: u64,
    output: u64,
    provider: (&str, &str, &str),
    left: (Option<u64>, Option<u64>),
) -> Value {
    let (provider_id, provider_name, model) = provider;
    serde_json::json!({
        "method": method.as_str(),
        "inputTokens": input,
        "outputTokens": output,
        "totalTokens": input + output,
        "providerId": provider_id,
        "providerName": provider_name,
        "model": model,
        "tokensLeftToday": left.0,
        "requestsLeftToday": left.1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt(system: &str, user: &str, max_tokens: u32) -> Prompt {
        Prompt { system: system.into(), user: user.into(), schema: None, max_tokens }
    }

    #[test]
    fn tokens_are_counted_by_script() {
        assert_eq!(tokens(["Hallo Nyu!"]), 3);
        assert_eq!(tokens(["東京で会議", "ab"]), 6, "a token per character, and one for the rest");
        assert_eq!(tokens(["회의 내일"]), 5);
        assert_eq!(tokens([""]), 0);
        assert_eq!(prompt_tokens(&prompt("abcd", "efgh", 10)), 2);
        let with_schema =
            Prompt { schema: Some(("x", serde_json::json!({ "type": "object" }))), ..prompt("abcd", "efgh", 10) };
        assert_eq!(prompt_tokens(&with_schema), 7, "the answer's shape goes along");
    }

    #[test]
    fn answers_are_typical_and_never_more_than_allowed() {
        let roomy = prompt("", "", 8000);
        assert_eq!(output_tokens(Answer::Write, &roomy), TYPICAL_WRITE_TOKENS);
        assert_eq!(output_tokens(Answer::Rewrite { text: "kurz" }, &roomy), MIN_REWRITE_TOKENS);
        assert_eq!(output_tokens(Answer::Rewrite { text: &"a".repeat(2000) }, &roomy), 500);
        assert_eq!(output_tokens(Answer::Summary { mails: 1 }, &roomy), 150);
        assert_eq!(output_tokens(Answer::Summary { mails: 3 }, &roomy), 250);
        assert_eq!(output_tokens(Answer::Summary { mails: 20 }, &roomy), TYPICAL_SUMMARY_MAX_TOKENS);
        assert_eq!(output_tokens(Answer::SpamCheck, &roomy), TYPICAL_SPAM_TOKENS);
        assert_eq!(output_tokens(Answer::Events, &prompt("", "", 100)), 100, "capped by the call's limit");
    }

    #[test]
    fn methods_have_the_servers_names() {
        for method in [Method::Compose, Method::Summarize, Method::SpamCheck, Method::ExtractEvents] {
            assert_eq!(Method::parse(method.as_str()), Some(method));
        }
        assert_eq!(Method::parse("Assist/estimate"), None);
        assert_eq!(Method::parse("AssistLabel/apply"), None);
        let answer = answer_json(Method::SpamCheck, 1200, 150, ("d1", "Ollama", "llama3"), (None, None));
        assert_eq!(answer["totalTokens"], 1350);
        assert!(answer["tokensLeftToday"].is_null());
    }
}
