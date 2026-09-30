//! What a call to the assistant would take, before it is made: the tooltip on its buttons.
//!
//! A UwUMail account asks its server (`Assist/estimate`, docs/jmap-assist.md of UwUMail Server);
//! every other mailbox counts here, with the same prompt the real call would send and the same
//! rough count as the server: about four characters to a token, a token for each character of
//! Chinese, Japanese or Korean. The answer is expected to be about as long as a typical one of its
//! kind, never more than the call allows the model.

use serde_json::{Value, json};

use super::prices::{CostParts, Price, PriceTable, Tokens};
use super::prompts::Prompt;
use super::provider::{ProviderKind, SCHEMA_INSTRUCTION};

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
/// Judging labels: a reason and a verdict per label, and new labels proposed on top; a thinking
/// model thinks about this much before (the server's numbers for `AssistLabel/suggest`).
pub const TYPICAL_VERDICT_TOKENS: u64 = 40;
pub const TYPICAL_NEW_LABELS_TOKENS: u64 = 120;
pub const TYPICAL_LABELS_REASONING_TOKENS: u64 = 300;
/// A reasoning model thinks about this many times as long as it answers, and at least this long.
pub const REASONING_PER_OUTPUT: u64 = 2;
pub const MIN_REASONING_TOKENS: u64 = 256;
/// Tokens each API adds around a system and a user message: role markers and the answer's start.
pub const CHAT_FRAMING_TOKENS: u64 = 9;
pub const MESSAGES_FRAMING_TOKENS: u64 = 8;
/// Calibration: this many recent calls are read, at least this many are needed, and a ratio stays
/// within these bounds.
pub const CALIBRATION_SAMPLES: usize = 50;
pub const MIN_CALIBRATION_SAMPLES: usize = 5;
pub const MIN_RATIO: f64 = 0.5;
pub const MAX_RATIO: f64 = 3.0;
/// What a picture that was never read counts: a short poster or ticket.
pub const UNREAD_PICTURE_CHARS: usize = 400;

/// The calls that can be estimated, as the server names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Compose,
    Summarize,
    SpamCheck,
    ExtractEvents,
    SuggestLabels,
}

impl Method {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "Assist/compose" => Some(Self::Compose),
            "Assist/summarize" => Some(Self::Summarize),
            "Assist/spamCheck" => Some(Self::SpamCheck),
            "Assist/extractEvents" => Some(Self::ExtractEvents),
            "AssistLabel/suggest" => Some(Self::SuggestLabels),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Compose => "Assist/compose",
            Self::Summarize => "Assist/summarize",
            Self::SpamCheck => "Assist/spamCheck",
            Self::ExtractEvents => "Assist/extractEvents",
            Self::SuggestLabels => "AssistLabel/suggest",
        }
    }

    pub fn feature(self) -> super::Feature {
        match self {
            Self::Compose => super::Feature::Compose,
            Self::Summarize => super::Feature::Summarize,
            Self::SpamCheck => super::Feature::SpamCheck,
            Self::ExtractEvents => super::Feature::ExtractEvents,
            Self::SuggestLabels => super::Feature::AutoLabels,
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
    /// Verdicts on this many labels, with new labels proposed or not.
    Labels {
        labels: usize,
        suggest_new: bool,
    },
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
        Answer::Labels { labels, suggest_new } => {
            TYPICAL_VERDICT_TOKENS * labels as u64 + if suggest_new { TYPICAL_NEW_LABELS_TOKENS } else { 0 }
        }
    };
    typical.min(u64::from(prompt.max_tokens))
}

/// Picture text for an estimate: what was read already, else a guess per picture, so hovering a
/// button never reads pictures.
pub fn unread_pictures(count: usize) -> Vec<String> {
    (0..count.min(20)).map(|_| "x".repeat(UNREAD_PICTURE_CHARS)).collect()
}

/// What the API around a prompt adds: role markers, the answer's start and, for Anthropic, the
/// sentence that introduces the answer's schema in the instructions.
pub fn framing_tokens(kind: ProviderKind, prompt: &Prompt) -> u64 {
    if kind.uses_messages_api() {
        MESSAGES_FRAMING_TOKENS + if prompt.schema.is_some() { tokens([SCHEMA_INSTRUCTION]) } else { 0 }
    } else {
        CHAT_FRAMING_TOKENS
    }
}

/// Whether a model thinks before it answers without being asked to: OpenAI's o-series and gpt-5,
/// Gemini 2.5 and later, DeepSeek R1, QwQ, Qwen 3, Magistral. Claude only thinks when asked,
/// which this app never does.
pub fn thinks(kind: ProviderKind, model: &str, listed: bool) -> bool {
    let model = model.to_lowercase();
    let name = model.rsplit('/').next().unwrap_or(&model);
    if kind == ProviderKind::Anthropic || (name.contains("claude") && !name.contains("thinking")) {
        return false;
    }
    if listed {
        return true;
    }
    let starts = |prefix: &str| name.starts_with(prefix);
    (starts("o1") || starts("o3") || starts("o4"))
        || (starts("gpt-5") && !name.contains("chat"))
        || starts("gemini-2.5")
        || starts("gemini-3")
        || ["deepseek-r1", "deepseek-reasoner", "qwq", "qwen3", "magistral", "thinking", "reasoning"]
            .iter()
            .any(|word| name.contains(word))
}

/// The reasoning a thinking model spends before an answer of `output` tokens, within `max_output`
/// (which reasoning counts against).
pub fn reasoning_tokens(output: u64, max_output: u64) -> u64 {
    (output * REASONING_PER_OUTPUT).max(MIN_REASONING_TOKENS).min(max_output.saturating_sub(output))
}

/// One call to a model that a request makes.
#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    /// `main`, `pictures`, `chunk`, `retry`, …
    pub purpose: &'static str,
    pub input: u64,
    pub output: u64,
    pub reasoning: u64,
    pub images: u64,
    /// How likely the call is made: 1 for certain, less for a retry that is only sometimes needed.
    pub weight: f64,
    /// The most it may write, reasoning included.
    pub max_output: u64,
}

impl Call {
    fn weighted(&self, value: u64) -> u64 {
        (value as f64 * self.weight).round() as u64
    }
}

/// A call as the heuristic sees it, before calibration: the prompt counted, the answer typical.
pub fn heuristic_call(kind: ProviderKind, prompt: &Prompt, output: u64, reasons: bool, limit: Option<u64>) -> Call {
    let max_output = limit.map_or(u64::from(prompt.max_tokens), |limit| limit.min(u64::from(prompt.max_tokens)));
    let output = output.min(max_output);
    Call {
        purpose: "main",
        input: prompt_tokens(prompt) + framing_tokens(kind, prompt),
        output,
        reasoning: if reasons { reasoning_tokens(output, max_output) } else { 0 },
        images: 0,
        weight: 1.0,
        max_output,
    }
}

/// What recent real calls of a provider, model and feature took against what was expected.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Sample {
    pub estimated_input: u64,
    pub estimated_output: u64,
    pub estimated_reasoning: u64,
    pub input: u64,
    pub output: u64,
    pub reasoning: u64,
}

/// How to correct the heuristic, learned from recent calls.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Calibration {
    pub input_ratio: f64,
    pub output_ratio: f64,
    /// The typical reasoning of recent calls.
    pub reasoning: u64,
}

fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    Some(if values.len().is_multiple_of(2) { (values[middle - 1] + values[middle]) / 2.0 } else { values[middle] })
}

/// The median ratios of the recent calls (at most [`CALIBRATION_SAMPLES`]), clamped; `None` with
/// fewer than [`MIN_CALIBRATION_SAMPLES`].
pub fn calibration(samples: &[Sample]) -> Option<Calibration> {
    let samples = &samples[..samples.len().min(CALIBRATION_SAMPLES)];
    if samples.len() < MIN_CALIBRATION_SAMPLES {
        return None;
    }
    let ratio = |pairs: Vec<(u64, u64)>| {
        median(pairs.into_iter().filter(|(estimated, _)| *estimated > 0).map(|(e, a)| a as f64 / e as f64).collect())
            .map_or(1.0, |ratio| ratio.clamp(MIN_RATIO, MAX_RATIO))
    };
    Some(Calibration {
        input_ratio: ratio(samples.iter().map(|s| (s.estimated_input, s.input)).collect()),
        output_ratio: ratio(samples.iter().map(|s| (s.estimated_output, s.output)).collect()),
        reasoning: median(samples.iter().map(|s| s.reasoning as f64).collect()).unwrap_or(0.0).round() as u64,
    })
}

impl Call {
    /// The call corrected by what recent calls took.
    pub fn calibrated(mut self, calibration: &Calibration) -> Self {
        let scale = |value: u64, ratio: f64| (value as f64 * ratio).round() as u64;
        self.input = scale(self.input, calibration.input_ratio);
        self.output = scale(self.output, calibration.output_ratio).min(self.max_output);
        self.reasoning = calibration.reasoning.min(self.max_output.saturating_sub(self.output));
        self
    }
}

/// A whole request: every call it makes.
#[derive(Debug, Clone, PartialEq)]
pub struct Estimate {
    pub calls: Vec<Call>,
    pub calibrated: bool,
}

impl Estimate {
    pub fn input(&self) -> u64 {
        self.calls.iter().map(|c| c.weighted(c.input)).sum()
    }

    pub fn output(&self) -> u64 {
        self.calls.iter().map(|c| c.weighted(c.output)).sum()
    }

    pub fn reasoning(&self) -> u64 {
        self.calls.iter().map(|c| c.weighted(c.reasoning)).sum()
    }

    pub fn images(&self) -> u64 {
        self.calls.iter().map(|c| c.weighted(c.images)).sum()
    }

    /// What it costs as expected, part by part, USD.
    pub fn cost(&self, price: &Price) -> CostParts {
        let mut parts = CostParts::default();
        for call in &self.calls {
            let tokens = Tokens {
                input: call.input,
                output: call.output,
                reasoning: call.reasoning,
                images: call.images,
                requests: 1,
                prompt_size: call.input,
                ..Tokens::default()
            };
            parts.add(&price.parts(&tokens).scaled(call.weight));
        }
        parts
    }

    /// The worst case, USD: every call made and each writing as much as it may.
    pub fn max_cost(&self, price: &Price) -> f64 {
        self.calls
            .iter()
            .map(|call| {
                let base = Tokens {
                    input: call.input,
                    images: call.images,
                    requests: 1,
                    prompt_size: call.input,
                    ..Tokens::default()
                };
                let as_output = price.parts(&Tokens { output: call.max_output, ..base }).total();
                let as_reasoning = price.parts(&Tokens { reasoning: call.max_output, ..base }).total();
                as_output.max(as_reasoning)
            })
            .sum()
    }
}

/// `{ amount, currency, usd, max: { amount, usd }, parts: { … } }` in `currency`; `null` without a
/// price, or without a rate for a cost that isn't free.
pub fn cost_json(table: &PriceTable, cost: Option<(CostParts, f64)>, currency: &str) -> Value {
    let Some((parts, max_usd)) = cost else { return Value::Null };
    let currency = currency.trim().to_ascii_uppercase();
    let usd = parts.total();
    let factor = match table.convert(1.0, &currency) {
        Some(factor) => factor,
        // Free is free in every currency, rates or not.
        None if usd == 0.0 && max_usd == 0.0 => 0.0,
        None => return Value::Null,
    };
    let money = |usd: f64| usd * factor;
    json!({
        "amount": money(usd),
        "currency": currency,
        "usd": usd,
        "max": { "amount": money(max_usd), "usd": max_usd },
        "parts": {
            "input": money(parts.input),
            "output": money(parts.output),
            "reasoning": money(parts.reasoning),
            "images": money(parts.images),
            "requests": money(parts.requests),
            "other": money(parts.other),
        },
    })
}

/// An estimate as the page gets it, in the shape of the server's `Assist/estimate` response.
pub fn answer_json(
    method: Method,
    estimate: &Estimate,
    provider: (&str, &str, &str),
    left: (Option<u64>, Option<u64>),
) -> Value {
    let (provider_id, provider_name, model) = provider;
    let (input, output, reasoning) = (estimate.input(), estimate.output(), estimate.reasoning());
    let calls: Vec<Value> = estimate
        .calls
        .iter()
        .map(|call| {
            json!({
                "purpose": call.purpose,
                "inputTokens": call.input,
                "outputTokens": call.output,
                "reasoningTokens": call.reasoning,
                "images": call.images,
                "weight": call.weight,
            })
        })
        .collect();
    json!({
        "method": method.as_str(),
        "inputTokens": input,
        "outputTokens": output,
        "reasoningTokens": reasoning,
        "totalTokens": input + output + reasoning,
        "imageCount": estimate.images(),
        "calls": calls,
        "calibrated": estimate.calibrated,
        "providerId": provider_id,
        "providerName": provider_name,
        "model": model,
        "tokensLeftToday": left.0,
        "requestsLeftToday": left.1,
        "cost": null,
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
    fn the_api_adds_its_framing() {
        let plain = prompt("abcd", "efgh", 100);
        assert_eq!(framing_tokens(ProviderKind::OpenAi, &plain), CHAT_FRAMING_TOKENS);
        assert_eq!(framing_tokens(ProviderKind::Anthropic, &plain), MESSAGES_FRAMING_TOKENS);
        let schema = Prompt { schema: Some(("x", json!({}))), ..plain };
        assert_eq!(
            framing_tokens(ProviderKind::Anthropic, &schema),
            MESSAGES_FRAMING_TOKENS + tokens([SCHEMA_INSTRUCTION]),
            "Anthropic gets the schema in the instructions, with a sentence before it"
        );
    }

    #[test]
    fn thinking_models_are_known() {
        for model in
            ["o3-mini", "o4-mini", "gpt-5-mini", "openai/gpt-5", "gemini-2.5-flash", "deepseek-r1:8b", "qwen3:4b"]
        {
            assert!(thinks(ProviderKind::OpenAiCompatible, model, false), "{model}");
        }
        for model in ["gpt-4o-mini", "gpt-5-chat-latest", "llama3", "mistral-small-latest", "gemini-2.0-flash"] {
            assert!(!thinks(ProviderKind::OpenAi, model, false), "{model}");
        }
        assert!(thinks(ProviderKind::Mistral, "some-new-model", true), "the price list knows");
        assert!(!thinks(ProviderKind::Anthropic, "claude-sonnet-4-5", true), "Claude only thinks when asked");
        assert!(!thinks(ProviderKind::OpenRouter, "anthropic/claude-sonnet-4.5", true));
        assert!(thinks(ProviderKind::OpenRouter, "anthropic/claude-3.7-sonnet:thinking", true));
    }

    #[test]
    fn reasoning_fits_in_what_the_call_allows() {
        assert_eq!(reasoning_tokens(150, 4000), 300);
        assert_eq!(reasoning_tokens(50, 4000), MIN_REASONING_TOKENS);
        assert_eq!(reasoning_tokens(150, 300), 150, "reasoning counts against the limit");
        let call = heuristic_call(ProviderKind::OpenAi, &prompt("abcd", "efgh", 4000), 150, true, Some(1000));
        assert_eq!(
            (call.input, call.output, call.reasoning, call.max_output),
            (2 + CHAT_FRAMING_TOKENS, 150, 300, 1000)
        );
        let quiet = heuristic_call(ProviderKind::OpenAi, &prompt("", "", 100), 150, false, None);
        assert_eq!((quiet.output, quiet.reasoning, quiet.max_output), (100, 0, 100));
    }

    fn sample(input: u64, output: u64, reasoning: u64) -> Sample {
        Sample { estimated_input: 1000, estimated_output: 100, estimated_reasoning: 0, input, output, reasoning }
    }

    #[test]
    fn calibration_takes_the_median_of_recent_calls() {
        assert_eq!(calibration(&[sample(2000, 50, 0); 4]), None, "too few calls");
        let samples = [
            sample(1500, 100, 10),
            sample(1200, 80, 30),
            sample(9000, 900, 20),
            sample(1100, 120, 40),
            sample(1300, 90, 50),
        ];
        let found = calibration(&samples).unwrap();
        assert_eq!(
            (found.input_ratio, found.output_ratio, found.reasoning),
            (1.3, 1.0, 30),
            "an outlier doesn't count"
        );
        let wild = calibration(&[sample(100_000, 1, 0); 6]).unwrap();
        assert_eq!((wild.input_ratio, wild.output_ratio), (MAX_RATIO, MIN_RATIO), "clamped");
        let call =
            Call { purpose: "main", input: 1000, output: 100, reasoning: 300, images: 0, weight: 1.0, max_output: 180 };
        let calibrated = call.calibrated(&Calibration { input_ratio: 1.5, output_ratio: 2.0, reasoning: 50 });
        assert_eq!((calibrated.input, calibrated.output, calibrated.reasoning), (1500, 180, 0), "within the limit");
    }

    #[test]
    fn costs_add_up_part_by_part_with_a_worst_case() {
        use super::super::prices::{PriceSheet, PriceSource};
        let sheet = PriceSheet {
            input: 1e-6,
            output: 4e-6,
            reasoning: Some(8e-6),
            per_request: 0.001,
            tiers: vec![super::super::prices::Tier { above: 5_000, input: Some(2e-6), output: None }],
            ..PriceSheet::default()
        };
        let price = Price { input_per_million: 1.0, output_per_million: 4.0, source: PriceSource::Auto, sheet };
        let main = Call {
            purpose: "main",
            input: 1000,
            output: 100,
            reasoning: 200,
            images: 0,
            weight: 1.0,
            max_output: 1000,
        };
        let retry =
            Call { purpose: "retry", input: 6000, output: 100, reasoning: 0, images: 0, weight: 0.5, max_output: 1000 };
        let estimate = Estimate { calls: vec![main, retry], calibrated: false };
        assert_eq!((estimate.input(), estimate.output(), estimate.reasoning()), (4000, 150, 200));
        let parts = estimate.cost(&price);
        let close = |a: f64, b: f64| (a - b).abs() < 1e-12;
        assert!(close(parts.input, 1000.0 * 1e-6 + 0.5 * 6000.0 * 2e-6), "the long prompt pays the higher tier");
        assert!(close(parts.output, 150.0 * 4e-6));
        assert!(close(parts.reasoning, 200.0 * 8e-6));
        assert!(close(parts.requests, 1.5 * 0.001));
        let max = estimate.max_cost(&price);
        assert!(close(max, (1000.0 * 1e-6 + 1000.0 * 8e-6 + 0.001) + (6000.0 * 2e-6 + 1000.0 * 8e-6 + 0.001)));

        let table =
            PriceTable { rates: [("USD".to_string(), 2.0), ("EUR".into(), 1.0)].into(), ..PriceTable::default() };
        let money = cost_json(&table, Some((parts, max)), "eur");
        assert_eq!(money["currency"], "EUR");
        assert!(close(money["amount"].as_f64().unwrap(), parts.total() / 2.0));
        assert!(close(money["max"]["usd"].as_f64().unwrap(), max));
        assert!(close(money["parts"]["reasoning"].as_f64().unwrap(), parts.reasoning / 2.0));
        assert!(cost_json(&table, None, "EUR").is_null());
        assert!(cost_json(&PriceTable::default(), Some((parts, max)), "EUR").is_null(), "no rate");
        let free = cost_json(&PriceTable::default(), Some((CostParts::default(), 0.0)), "JPY");
        assert_eq!((free["amount"].as_f64(), free["max"]["amount"].as_f64()), (Some(0.0), Some(0.0)));
    }

    #[test]
    fn methods_have_the_servers_names() {
        for method in
            [Method::Compose, Method::Summarize, Method::SpamCheck, Method::ExtractEvents, Method::SuggestLabels]
        {
            assert_eq!(Method::parse(method.as_str()), Some(method));
        }
        assert_eq!(Method::parse("Assist/estimate"), None);
        assert_eq!(Method::parse("AssistLabel/apply"), None);
        let call =
            Call { purpose: "main", input: 1200, output: 150, reasoning: 0, images: 0, weight: 1.0, max_output: 4000 };
        let estimate = Estimate { calls: vec![call], calibrated: false };
        let answer = answer_json(Method::SpamCheck, &estimate, ("d1", "Ollama", "llama3"), (None, None));
        assert_eq!(answer["totalTokens"], 1350);
        assert!(answer["tokensLeftToday"].is_null());
        assert_eq!(answer["calls"][0]["purpose"], "main");
        assert_eq!(answer["calibrated"], false);
    }
}
