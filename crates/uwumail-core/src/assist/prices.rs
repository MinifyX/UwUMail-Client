//! What the assistant costs on this device's own providers, the way UwUMail Server prices its own:
//! LiteLLM's price list (USD per token), OpenRouter's own prices, and the ECB's reference rates for
//! the person's currency. Fetched at most once a day and kept in the store, so costs still show
//! offline with the last good copy. A price set by hand on a provider wins; Ollama and servers on
//! this computer or in the local network (LM Studio) are free.

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::provider::ProviderKind;

/// Where the prices come from.
#[derive(Debug, Clone)]
pub struct Sources {
    pub litellm: String,
    pub openrouter: String,
    pub ecb: String,
}

impl Default for Sources {
    fn default() -> Self {
        Self {
            litellm: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
                .into(),
            openrouter: "https://openrouter.ai/api/v1/models".into(),
            ecb: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml".into(),
        }
    }
}

/// A day: prices and rates are asked for again after this.
pub const MAX_AGE_SECS: i64 = 24 * 60 * 60;
/// After a failed attempt, the next one waits this long.
pub const RETRY_SECS: i64 = 60 * 60;
/// One source may take this long.
const FETCH_WAIT: Duration = Duration::from_secs(20);
/// LiteLLM's list is a few megabytes; nothing bigger is read.
const MAX_BYTES: usize = 24 * 1024 * 1024;

/// USD per token, input and output.
pub type TokenPrice = (f64, f64);

/// The prices and rates as last fetched.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceTable {
    /// Unix seconds of the last complete fetch; 0 when never.
    pub fetched_at: i64,
    /// Unix seconds of the last attempt, successful or not.
    #[serde(default)]
    pub attempted_at: i64,
    /// LiteLLM's models by lower-case name.
    #[serde(default)]
    pub models: HashMap<String, TokenPrice>,
    /// OpenRouter's models by lower-case id.
    #[serde(default)]
    pub openrouter: HashMap<String, TokenPrice>,
    /// Units of a currency per euro (ECB), `EUR` itself included.
    #[serde(default)]
    pub rates: HashMap<String, f64>,
}

/// A model's price as the page shows it: USD per million tokens, and where it comes from.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Price {
    pub input_per_million: f64,
    pub output_per_million: f64,
    pub source: PriceSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PriceSource {
    Auto,
    Manual,
    Free,
}

impl Price {
    /// USD for so many tokens.
    pub fn usd(&self, input_tokens: u64, output_tokens: u64) -> f64 {
        (input_tokens as f64 * self.input_per_million + output_tokens as f64 * self.output_per_million) / 1_000_000.0
    }
}

fn finite(value: &Value) -> Option<f64> {
    let number = match value {
        Value::Number(number) => number.as_f64(),
        // OpenRouter writes its prices as text.
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }?;
    (number.is_finite() && number >= 0.0).then_some(number)
}

/// LiteLLM's `model_prices_and_context_window.json`: every entry with both prices per token.
pub fn parse_litellm(value: &Value) -> HashMap<String, TokenPrice> {
    let Some(entries) = value.as_object() else { return HashMap::new() };
    entries
        .iter()
        .filter_map(|(name, entry)| {
            let input = finite(entry.get("input_cost_per_token")?)?;
            let output = finite(entry.get("output_cost_per_token")?)?;
            Some((name.trim().to_lowercase(), (input, output)))
        })
        .collect()
}

/// OpenRouter's `/api/v1/models`: `data[].id` with `pricing.prompt` and `pricing.completion` per token.
pub fn parse_openrouter(value: &Value) -> HashMap<String, TokenPrice> {
    value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?.trim().to_lowercase();
            let pricing = entry.get("pricing")?;
            Some((id, (finite(pricing.get("prompt")?)?, finite(pricing.get("completion")?)?)))
        })
        .collect()
}

/// The ECB's daily reference rates: `<Cube currency='USD' rate='1.1734'/>`, units per euro.
pub fn parse_ecb(xml: &str) -> HashMap<String, f64> {
    let mut rates = HashMap::new();
    for part in xml.split("<Cube").skip(1) {
        let attribute = |name: &str| {
            let start = part.find(&format!("{name}="))? + name.len() + 1;
            let quote = part[start..].chars().next()?;
            let rest = &part[start + quote.len_utf8()..];
            Some(rest[..rest.find(quote)?].to_string())
        };
        if let (Some(currency), Some(rate)) = (attribute("currency"), attribute("rate"))
            && currency.len() == 3
            && currency.chars().all(|c| c.is_ascii_uppercase())
            && let Ok(rate) = rate.trim().parse::<f64>()
            && rate.is_finite()
            && rate > 0.0
        {
            rates.insert(currency, rate);
        }
    }
    if !rates.is_empty() {
        rates.insert("EUR".into(), 1.0);
    }
    rates
}

/// A model name without a date at its end: `claude-sonnet-4-5-20250929`, `gpt-4o-2024-08-06`.
fn without_date(name: &str) -> Option<&str> {
    let bytes = name.as_bytes();
    let digits = |from: usize, to: usize| bytes[from..to].iter().all(u8::is_ascii_digit);
    let n = bytes.len();
    if n > 9 && matches!(bytes[n - 9], b'-' | b'@') && digits(n - 8, n) {
        return Some(&name[..n - 9]);
    }
    if n > 11 && bytes[n - 11] == b'-' && digits(n - 10, n - 6) && bytes[n - 6] == b'-' && digits(n - 5, n - 3) {
        return (bytes[n - 3] == b'-' && digits(n - 2, n)).then(|| &name[..n - 11]);
    }
    None
}

impl PriceTable {
    /// Whether it is time to ask again.
    pub fn due(&self, now: i64) -> bool {
        now - self.fetched_at >= MAX_AGE_SECS && now - self.attempted_at >= RETRY_SECS
    }

    /// The price per token of a model, found tolerantly: with or without the provider's prefix
    /// (`mistral/…`, `openai/…`) and a date at the end.
    pub fn lookup(&self, kind: ProviderKind, model: &str) -> Option<TokenPrice> {
        let model = model.trim().to_lowercase();
        if model.is_empty() {
            return None;
        }
        let bare = model.rsplit_once('/').map_or(model.as_str(), |(_, name)| name).to_string();
        let prefix = match kind {
            ProviderKind::OpenAi => Some("openai"),
            ProviderKind::Anthropic => Some("anthropic"),
            ProviderKind::Gemini => Some("gemini"),
            ProviderKind::Mistral => Some("mistral"),
            ProviderKind::OpenRouter => Some("openrouter"),
            ProviderKind::Ollama | ProviderKind::OpenAiCompatible => None,
        };
        if kind == ProviderKind::OpenRouter
            && let Some(price) = self.openrouter.get(&model)
        {
            return Some(*price);
        }
        let mut names = vec![model.clone()];
        if let Some(prefix) = prefix {
            names.push(format!("{prefix}/{model}"));
        }
        names.push(bare.clone());
        if let Some(prefix) = prefix {
            names.push(format!("{prefix}/{bare}"));
        }
        for name in [model.as_str(), bare.as_str()] {
            if let Some(short) = without_date(name) {
                names.push(short.to_string());
                if let Some(prefix) = prefix {
                    names.push(format!("{prefix}/{short}"));
                }
            }
        }
        names.iter().find_map(|name| self.models.get(name).copied())
    }

    /// USD in another currency by the ECB's rates; `None` for a currency they don't have.
    pub fn convert(&self, usd: f64, currency: &str) -> Option<f64> {
        let currency = currency.trim().to_ascii_uppercase();
        if currency == "USD" {
            return Some(usd);
        }
        let per_euro_usd = self.rates.get("USD")?;
        let per_euro = self.rates.get(&currency)?;
        Some(usd / per_euro_usd * per_euro)
    }

    /// `{ amount, currency, usd }` as the server answers a cost; `None` without a price or rate.
    pub fn cost_json(&self, usd: Option<f64>, currency: &str) -> Value {
        let Some(usd) = usd else { return Value::Null };
        let currency = currency.trim().to_ascii_uppercase();
        // Free is free in every currency, rates or not.
        let amount = if usd == 0.0 { Some(0.0) } else { self.convert(usd, &currency) };
        match amount {
            Some(amount) => json!({ "amount": amount, "currency": currency, "usd": usd }),
            None => Value::Null,
        }
    }

    /// Takes over what a fetch brought; parts that failed keep the last good copy.
    pub fn merge(&mut self, fetched: Fetched, now: i64) {
        self.attempted_at = now;
        let complete = fetched.models.is_some() && fetched.rates.is_some();
        if let Some(models) = fetched.models {
            self.models = models;
        }
        if let Some(openrouter) = fetched.openrouter {
            self.openrouter = openrouter;
        }
        if let Some(rates) = fetched.rates {
            self.rates = rates;
        }
        if complete {
            self.fetched_at = now;
        }
    }
}

/// Whether an address is on this computer or in the local network: a model there costs nothing.
pub fn is_local_address(base_url: Option<&str>) -> bool {
    let Some(url) = base_url.and_then(|url| url::Url::parse(url).ok()) else { return false };
    match url.host() {
        Some(url::Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            name == "localhost" || name.ends_with(".localhost") || name.ends_with(".local") || name.ends_with(".lan")
        }
        Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local(),
        None => false,
    }
}

/// What a model on a provider costs: the price set by hand, free for local models, else the
/// known price. `None` when nothing is known.
pub fn price_for(
    kind: ProviderKind,
    base_url: Option<&str>,
    manual: (Option<f64>, Option<f64>),
    model: &str,
    table: Option<&PriceTable>,
) -> Option<Price> {
    if manual.0.is_some() || manual.1.is_some() {
        return Some(Price {
            input_per_million: manual.0.unwrap_or(0.0),
            output_per_million: manual.1.unwrap_or(0.0),
            source: PriceSource::Manual,
        });
    }
    if kind == ProviderKind::Ollama || (kind == ProviderKind::OpenAiCompatible && is_local_address(base_url)) {
        return Some(Price { input_per_million: 0.0, output_per_million: 0.0, source: PriceSource::Free });
    }
    let (input, output) = table?.lookup(kind, model)?;
    Some(Price {
        input_per_million: input * 1_000_000.0,
        output_per_million: output * 1_000_000.0,
        source: PriceSource::Auto,
    })
}

/// What one fetch brought; `None` for a source that failed.
#[derive(Debug, Default)]
pub struct Fetched {
    pub models: Option<HashMap<String, TokenPrice>>,
    pub openrouter: Option<HashMap<String, TokenPrice>>,
    pub rates: Option<HashMap<String, f64>>,
}

async fn body(http: &reqwest::Client, url: &str) -> Option<Vec<u8>> {
    let work = async {
        let mut response = http.get(url).send().await.ok()?;
        if !response.status().is_success() || response.content_length().is_some_and(|n| n as usize > MAX_BYTES) {
            return None;
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            bytes.extend_from_slice(&chunk);
            if bytes.len() > MAX_BYTES {
                return None;
            }
        }
        Some(bytes)
    };
    tokio::time::timeout(FETCH_WAIT, work).await.ok()?
}

/// Asks all three sources at the same time; an empty answer counts as a failure.
pub async fn fetch(http: &reqwest::Client, sources: &Sources) -> Fetched {
    let json = |bytes: Option<Vec<u8>>| bytes.and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let (litellm, openrouter, ecb) =
        tokio::join!(body(http, &sources.litellm), body(http, &sources.openrouter), body(http, &sources.ecb));
    let non_empty = |map: HashMap<String, TokenPrice>| (!map.is_empty()).then_some(map);
    Fetched {
        models: json(litellm).map(|v| parse_litellm(&v)).and_then(non_empty),
        openrouter: json(openrouter).map(|v| parse_openrouter(&v)).and_then(non_empty),
        rates: ecb
            .and_then(|b| String::from_utf8(b).ok())
            .map(|xml| parse_ecb(&xml))
            .filter(|rates| rates.contains_key("USD")),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    pub(crate) const LITELLM: &str = r#"{
        "sample_spec": { "input_cost_per_token": "cost per token", "output_cost_per_token": 0 },
        "gpt-5-mini": { "input_cost_per_token": 2.5e-7, "output_cost_per_token": 2e-6, "litellm_provider": "openai" },
        "claude-sonnet-4-5": { "input_cost_per_token": 3e-6, "output_cost_per_token": 1.5e-5 },
        "mistral/mistral-small-latest": { "input_cost_per_token": 1e-7, "output_cost_per_token": 3e-7 },
        "gemini/gemini-2.5-flash": { "input_cost_per_token": 3e-7, "output_cost_per_token": 2.5e-6 },
        "text-embedding-3-small": { "input_cost_per_token": 2e-8 }
    }"#;

    pub(crate) const ECB: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube><Cube time='2026-09-29'>
    <Cube currency='USD' rate='1.1700'/><Cube currency='JPY' rate='170.00'/>
    <Cube currency="CNY" rate="8.40"/><Cube currency='bad' rate='x'/>
  </Cube></Cube>
</gesmes:Envelope>"#;

    pub(crate) const OPENROUTER: &str = r#"{ "data": [
        { "id": "openai/gpt-5-mini", "pricing": { "prompt": "0.00000025", "completion": "0.000002" } },
        { "id": "meta-llama/llama-3.3-70b-instruct:free", "pricing": { "prompt": "0", "completion": "0" } },
        { "id": "broken", "pricing": { "prompt": "much" } }
    ] }"#;

    fn table() -> PriceTable {
        PriceTable {
            fetched_at: 1,
            attempted_at: 1,
            models: parse_litellm(&serde_json::from_str(LITELLM).unwrap()),
            openrouter: parse_openrouter(&serde_json::from_str(OPENROUTER).unwrap()),
            rates: parse_ecb(ECB),
        }
    }

    #[test]
    fn reads_the_sources() {
        let table = table();
        assert_eq!(table.models.len(), 4, "entries without both prices are left out: {:?}", table.models.keys());
        assert_eq!(table.models["gpt-5-mini"], (2.5e-7, 2e-6));
        assert_eq!(table.openrouter.len(), 2);
        assert_eq!(table.rates.get("USD"), Some(&1.17));
        assert_eq!(table.rates.get("CNY"), Some(&8.4));
        assert_eq!(table.rates.get("EUR"), Some(&1.0));
        assert!(!table.rates.contains_key("bad"));
        assert!(parse_ecb("<html>nope</html>").is_empty());
    }

    #[test]
    fn finds_models_tolerantly() {
        let table = table();
        assert_eq!(table.lookup(ProviderKind::OpenAi, "GPT-5-mini"), Some((2.5e-7, 2e-6)));
        assert_eq!(table.lookup(ProviderKind::Mistral, "mistral-small-latest"), Some((1e-7, 3e-7)), "with the prefix");
        assert_eq!(table.lookup(ProviderKind::Gemini, "models/gemini-2.5-flash"), Some((3e-7, 2.5e-6)));
        assert_eq!(table.lookup(ProviderKind::Anthropic, "claude-sonnet-4-5-20250929"), Some((3e-6, 1.5e-5)));
        assert_eq!(table.lookup(ProviderKind::OpenAi, "gpt-5-mini-2025-08-07"), Some((2.5e-7, 2e-6)));
        assert_eq!(table.lookup(ProviderKind::OpenRouter, "meta-llama/llama-3.3-70b-instruct:free"), Some((0.0, 0.0)));
        assert_eq!(table.lookup(ProviderKind::OpenAiCompatible, "openai/gpt-5-mini"), Some((2.5e-7, 2e-6)));
        assert_eq!(table.lookup(ProviderKind::OpenAi, "gpt-9-imaginary"), None);
        assert_eq!(table.lookup(ProviderKind::OpenAi, ""), None);
    }

    #[test]
    fn prices_by_hand_free_or_known() {
        let table = table();
        let auto = price_for(ProviderKind::OpenAi, None, (None, None), "gpt-5-mini", Some(&table)).unwrap();
        assert_eq!(auto.source, PriceSource::Auto);
        assert!((auto.input_per_million - 0.25).abs() < 1e-9 && (auto.output_per_million - 2.0).abs() < 1e-9);
        // 1,000,000 in and 500,000 out: 0.25 + 1.0 USD.
        assert!((auto.usd(1_000_000, 500_000) - 1.25).abs() < 1e-9);
        let manual = price_for(ProviderKind::OpenAi, None, (Some(1.0), None), "gpt-5-mini", Some(&table)).unwrap();
        assert_eq!(
            (manual.source, manual.input_per_million, manual.output_per_million),
            (PriceSource::Manual, 1.0, 0.0)
        );
        let ollama =
            price_for(ProviderKind::Ollama, Some("http://192.0.2.10:11434/v1"), (None, None), "x", None).unwrap();
        assert_eq!(ollama.source, PriceSource::Free);
        let studio =
            price_for(ProviderKind::OpenAiCompatible, Some("http://127.0.0.1:1234/v1"), (None, None), "x", None);
        assert_eq!(studio.unwrap().source, PriceSource::Free);
        let remote = price_for(
            ProviderKind::OpenAiCompatible,
            Some("https://llm.example.com/v1"),
            (None, None),
            "x",
            Some(&table),
        );
        assert_eq!(remote, None, "an unknown model elsewhere has no price");
        assert_eq!(
            price_for(ProviderKind::OpenAi, None, (None, None), "gpt-5-mini", None),
            None,
            "nothing fetched yet"
        );
    }

    #[test]
    fn converts_with_the_ecbs_rates() {
        let table = table();
        assert_eq!(table.convert(1.0, "usd"), Some(1.0));
        assert!((table.convert(1.17, "EUR").unwrap() - 1.0).abs() < 1e-9);
        assert!((table.convert(1.17, "JPY").unwrap() - 170.0).abs() < 1e-9);
        assert_eq!(table.convert(1.0, "XYZ"), None);
        assert_eq!(table.cost_json(Some(1.17), "eur")["currency"], "EUR");
        assert!(table.cost_json(None, "EUR").is_null());
        assert!(PriceTable::default().cost_json(Some(1.0), "EUR").is_null(), "no rates, no cost");
        assert_eq!(PriceTable::default().cost_json(Some(0.0), "JPY")["amount"], 0.0, "free needs no rate");
    }

    #[test]
    fn keeps_the_last_good_copy() {
        let mut table = table();
        let before = table.clone();
        let later = MAX_AGE_SECS + 10;
        assert!(table.due(later));
        table.merge(Fetched::default(), later);
        assert_eq!((table.models.len(), table.rates.len()), (before.models.len(), before.rates.len()));
        assert_eq!((table.fetched_at, table.attempted_at), (1, later));
        assert!(!table.due(later + RETRY_SECS - 1), "a failed attempt waits");
        assert!(table.due(later + RETRY_SECS));
        let again = later + RETRY_SECS;
        table.merge(
            Fetched { models: Some(HashMap::new()), rates: Some(before.rates.clone()), openrouter: None },
            again,
        );
        assert_eq!(table.fetched_at, again);
        assert!(!table.due(again + MAX_AGE_SECS - 1));
    }

    /// Answers requests by path on 127.0.0.1.
    pub(crate) async fn serve(routes: Vec<(&'static str, u16, &'static str)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buffer = [0u8; 4096];
                let read = socket.read(&mut buffer).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (status, body) =
                    routes.iter().find(|(p, _, _)| *p == path).map_or((404, ""), |(_, status, body)| (*status, *body));
                let head =
                    format!("HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(body.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        base
    }

    #[tokio::test]
    async fn fetches_each_source_on_its_own() {
        let http = reqwest::Client::new();
        let base = serve(vec![("/litellm", 200, LITELLM), ("/ecb", 200, ECB), ("/openrouter", 500, "")]).await;
        let sources = Sources {
            litellm: format!("{base}/litellm"),
            openrouter: format!("{base}/openrouter"),
            ecb: format!("{base}/ecb"),
        };
        let fetched = fetch(&http, &sources).await;
        assert_eq!(fetched.models.as_ref().map(HashMap::len), Some(4));
        assert!(fetched.openrouter.is_none(), "a failed source is left out");
        assert_eq!(fetched.rates.as_ref().and_then(|r| r.get("JPY")), Some(&170.0));
        let mut table = PriceTable::default();
        table.merge(fetched, 5);
        assert_eq!(table.fetched_at, 5);
    }
}
