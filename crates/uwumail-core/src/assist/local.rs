//! The assistant on this device, for every mailbox whose server has none: the providers the person
//! set up here, the choice per feature, labels and usage, answered in the same shapes as UwUMail
//! Server's JMAP extension so the page shows both alike.
//!
//! Keys live in the system keychain (entry `assist-provider:<id>`, [`Secret::ApiKey`]); the store
//! keeps only the last four characters to show. They never go to the page or into a log.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::estimate::{self, Call, Estimate, Sample};
use super::prices::{self, Price, PriceTable};
use super::prompts::Prompt;
use super::provider::{self, ChatAnswer, ChatMessage, ChatRequest, Endpoint, JsonSchema, ProviderKind, Role};
use super::validate::label_keyword;
use super::{Feature, Label};
use crate::error::{Error, Result};
use crate::secrets::{Secret, SecretStore};
use crate::store::{CalibrationRecord, ProviderRecord, Store, UsageRecord};

pub const MAX_PROVIDERS: usize = 10;
pub const MAX_LABELS: usize = 30;
pub const MAX_INSTRUCTION_CHARS: usize = 2_000;
pub const MAX_TEXT_CHARS: usize = 20_000;
const MAX_NAME_CHARS: usize = 60;
const MAX_LABEL_NAME_CHARS: usize = 40;
const MAX_LABEL_DESCRIPTION_CHARS: usize = 300;
const MAX_MODEL_CHARS: usize = 200;
/// A price set by hand, USD per million tokens, at most.
const MAX_PRICE_PER_MILLION: f64 = 10_000.0;
/// Labels asked for on new mail per day, at most: auto-labels cost money on most providers.
pub const AUTO_LABELS_PER_DAY: u64 = 200;
/// Usage is kept this long.
const USAGE_DAYS: i64 = 400;

pub fn secret_id(provider_id: &str) -> String {
    format!("assist-provider:{provider_id}")
}

fn invalid(property: &str, description: &str) -> Error {
    Error::assist("invalidProperties", description).with_properties(vec![property.to_string()])
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// The UTC day of unix seconds, `YYYY-MM-DD`.
pub fn utc_day(secs: i64) -> String {
    chrono::DateTime::from_timestamp(secs, 0).map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()
}

/// What the device offers, in the shape of the server's account capability.
pub fn options(features: &Value) -> Value {
    json!({
        "features": features,
        "mayAddProviders": true,
        "mayUsePrivateAddresses": true,
        "maxProviders": MAX_PROVIDERS,
        "maxLabels": MAX_LABELS,
        "maxInstructionChars": MAX_INSTRUCTION_CHARS,
        "maxTextChars": MAX_TEXT_CHARS,
    })
}

/// A choice of provider (and model) for a feature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    pub provider_id: String,
    pub model: Option<String>,
}

impl Choice {
    fn from_value(value: &Value) -> Option<Self> {
        let provider_id = value.get("providerId")?.as_str()?.to_string();
        let model = value.get("model").and_then(Value::as_str).map(str::trim).filter(|m| !m.is_empty());
        Some(Self { provider_id, model: model.map(|m| m.chars().take(MAX_MODEL_CHARS).collect()) })
    }

    fn to_value(&self) -> Value {
        json!({ "providerId": self.provider_id, "model": self.model })
    }
}

/// What a feature really uses.
#[derive(Debug, Clone)]
pub struct Effective {
    pub provider: ProviderRecord,
    pub kind: ProviderKind,
    pub model: String,
}

pub struct Device<'a> {
    pub store: &'a Store,
    pub secrets: &'a dyn SecretStore,
    /// The known prices, as far as they were fetched.
    pub prices: Option<Arc<PriceTable>>,
}

impl Device<'_> {
    fn kind_of(record: &ProviderRecord) -> Option<ProviderKind> {
        ProviderKind::parse(&record.kind)
    }

    fn usable(record: &ProviderRecord) -> bool {
        Self::kind_of(record).is_some_and(|kind| record.key_hint.is_some() || !kind.key_required())
    }

    pub fn providers(&self) -> Result<Vec<ProviderRecord>> {
        self.store.assist_providers()
    }

    fn provider(&self, id: &str) -> Result<ProviderRecord> {
        self.providers()?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| Error::assist("notFound", "This provider no longer exists."))
    }

    /// What a model of a provider costs: set by hand, free when it runs here, else the known price.
    pub fn price_of(&self, record: &ProviderRecord, model: &str) -> Option<Price> {
        let kind = Self::kind_of(record)?;
        prices::price_for(
            kind,
            record.base_url.as_deref(),
            (record.input_price, record.output_price),
            model,
            self.prices.as_deref(),
        )
    }

    /// A provider as the server's `AssistProvider` object, with the price of its default model.
    pub fn provider_json(&self, record: &ProviderRecord) -> Value {
        let kind = Self::kind_of(record);
        let model = record.model.clone().or_else(|| kind.and_then(|k| k.default_models().0).map(String::from));
        json!({
            "id": record.id,
            "name": record.name,
            "kind": record.kind,
            "scope": "personal",
            "baseUrl": record.base_url,
            "hasKey": record.key_hint.is_some(),
            "keyHint": record.key_hint.as_ref().map(|hint| format!("…{hint}")),
            "model": record.model,
            "fastModel": record.fast_model,
            "features": Feature::ALL.iter().map(|f| f.as_str()).collect::<Vec<_>>(),
            "quota": null,
            "experimental": false,
            "connected": Self::usable(record) && kind.is_some(),
            "inputPricePerMillion": record.input_price,
            "outputPricePerMillion": record.output_price,
            "price": model.and_then(|model| self.price_of(record, &model)),
        })
    }

    pub fn providers_json(&self) -> Result<Value> {
        Ok(Value::Array(self.providers()?.iter().map(|record| self.provider_json(record)).collect()))
    }

    fn text_field(input: &Value, key: &str, max: usize) -> Result<Option<Option<String>>> {
        match input.get(key) {
            None => Ok(None),
            Some(Value::Null) => Ok(Some(None)),
            Some(Value::String(text)) => {
                let text = text.trim();
                if text.chars().count() > max {
                    return Err(invalid(key, "This is too long."));
                }
                Ok(Some((!text.is_empty()).then(|| text.to_string())))
            }
            Some(_) => Err(invalid(key, "This must be text.")),
        }
    }

    /// A price set by hand: USD per million tokens, or `null` for the known price.
    fn price_field(input: &Value, key: &str) -> Result<Option<Option<f64>>> {
        match input.get(key) {
            None => Ok(None),
            Some(Value::Null) => Ok(Some(None)),
            Some(value) => match value.as_f64() {
                Some(price) if price.is_finite() && (0.0..=MAX_PRICE_PER_MILLION).contains(&price) => {
                    Ok(Some(Some(price)))
                }
                _ => Err(invalid(key, "This must be a price of at least 0.")),
            },
        }
    }

    fn checked_base_url(kind: ProviderKind, value: Option<String>) -> Result<Option<String>> {
        match value {
            None if kind.base_url_required() => Err(invalid("baseUrl", "This provider needs an address.")),
            None => Ok(None),
            Some(_) if !kind.base_url_editable() && !kind.base_url_required() => {
                Err(invalid("baseUrl", "This provider's address can't be changed."))
            }
            Some(url) => provider::check_base_url(kind, &url).map(Some).map_err(|reason| invalid("baseUrl", &reason)),
        }
    }

    fn store_key(&self, id: &str, key: &str) -> Result<Option<String>> {
        let key = key.trim();
        if key.is_empty() {
            self.secrets.delete(&secret_id(id))?;
            return Ok(None);
        }
        if key.chars().count() > 4096 || key.chars().any(char::is_control) {
            return Err(invalid("apiKey", "This isn't a key."));
        }
        self.secrets.set(&secret_id(id), &Secret::ApiKey { api_key: key.to_string() })?;
        let chars: Vec<char> = key.chars().collect();
        Ok(Some(chars[chars.len().saturating_sub(4)..].iter().collect()))
    }

    /// Adds a provider; answers it as `AssistProvider`.
    pub fn create_provider(&self, input: &Value) -> Result<Value> {
        let existing = self.providers()?;
        if existing.len() >= MAX_PROVIDERS {
            return Err(Error::assist("overQuota", "There are as many providers as there may be."));
        }
        let kind = input
            .get("kind")
            .and_then(Value::as_str)
            .and_then(ProviderKind::parse)
            .ok_or_else(|| invalid("kind", "This kind of provider can't be used on this device."))?;
        let name = Self::text_field(input, "name", MAX_NAME_CHARS)?
            .flatten()
            .ok_or_else(|| invalid("name", "A provider needs a name."))?;
        let base_url = Self::checked_base_url(kind, Self::text_field(input, "baseUrl", 2048)?.flatten())?;
        let id = format!("d{}", uuid::Uuid::new_v4().simple());
        let key_hint = match input.get("apiKey").and_then(Value::as_str) {
            Some(key) => self.store_key(&id, key)?,
            None => None,
        };
        let record = ProviderRecord {
            id,
            name,
            kind: kind.as_str().to_string(),
            base_url,
            model: Self::text_field(input, "model", MAX_MODEL_CHARS)?.flatten(),
            fast_model: Self::text_field(input, "fastModel", MAX_MODEL_CHARS)?.flatten(),
            key_hint,
            created_at: now(),
            input_price: Self::price_field(input, "inputPricePerMillion")?.flatten(),
            output_price: Self::price_field(input, "outputPricePerMillion")?.flatten(),
        };
        if let Err(error) = self.store.save_assist_provider(&record) {
            let _ = self.secrets.delete(&secret_id(&record.id));
            return Err(error);
        }
        Ok(self.provider_json(&record))
    }

    /// Changes what the patch names; `apiKey` left out keeps the key, `""` removes it.
    pub fn update_provider(&self, id: &str, patch: &Value) -> Result<()> {
        let mut record = self.provider(id)?;
        let kind = Self::kind_of(&record).ok_or_else(|| invalid("kind", "Unknown kind."))?;
        if let Some(name) = Self::text_field(patch, "name", MAX_NAME_CHARS)? {
            record.name = name.ok_or_else(|| invalid("name", "A provider needs a name."))?;
        }
        if let Some(base_url) = Self::text_field(patch, "baseUrl", 2048)? {
            record.base_url = Self::checked_base_url(kind, base_url)?;
        }
        if let Some(model) = Self::text_field(patch, "model", MAX_MODEL_CHARS)? {
            record.model = model;
        }
        if let Some(model) = Self::text_field(patch, "fastModel", MAX_MODEL_CHARS)? {
            record.fast_model = model;
        }
        if let Some(price) = Self::price_field(patch, "inputPricePerMillion")? {
            record.input_price = price;
        }
        if let Some(price) = Self::price_field(patch, "outputPricePerMillion")? {
            record.output_price = price;
        }
        if let Some(key) = patch.get("apiKey").and_then(Value::as_str) {
            record.key_hint = self.store_key(id, key)?;
        }
        self.store.save_assist_provider(&record)
    }

    /// Deletes a provider, its key and every choice that names it.
    pub fn delete_provider(&self, id: &str) -> Result<()> {
        self.provider(id)?;
        self.store.delete_assist_provider(id)?;
        self.store.forget_assist_calibration(id)?;
        self.secrets.delete(&secret_id(id))?;
        for key in std::iter::once("default".to_string())
            .chain(Feature::ALL.iter().map(|f| format!("features/{}", f.as_str())))
        {
            if self.choice(&key)?.is_some_and(|choice| choice.provider_id == id) {
                self.store.set_assist_setting(&key, None)?;
            }
        }
        Ok(())
    }

    /// Where and how to reach a provider, with its key from the keychain.
    pub fn endpoint(&self, record: &ProviderRecord) -> Result<Endpoint> {
        let kind = Self::kind_of(record).ok_or_else(|| Error::assist("assistUnavailable", "Unknown provider."))?;
        let api_key = match record.key_hint {
            Some(_) => match self.secrets.get(&secret_id(&record.id)) {
                Ok(Secret::ApiKey { api_key }) => Some(api_key),
                _ => return Err(Error::assist("providerFailed", "The provider's key is gone from this device.")),
            },
            None => None,
        };
        Ok(Endpoint { kind, base_url: record.base_url.clone(), api_key })
    }

    /// The models a provider offers, with its settings or the kind's suggestion.
    pub async fn models(&self, http: &reqwest::Client, id: &str) -> Result<Value> {
        let record = self.provider(id)?;
        let kind = Self::kind_of(&record).ok_or_else(|| Error::assist("notFound", "Unknown provider."))?;
        let endpoint = self.endpoint(&record)?;
        let models = provider::models(http, &endpoint).await?;
        let (model, fast) = kind.default_models();
        Ok(json!({
            "models": models,
            "model": record.model.as_deref().or(model),
            "fastModel": record.fast_model.as_deref().or(fast),
        }))
    }

    /// The models at an address that isn't saved yet: `{ kind, baseUrl, apiKey? }` of an Ollama or
    /// OpenAI-compatible server. The address passes the same check as a saved one; a key only
    /// goes along for the question.
    pub async fn probe_models(&self, http: &reqwest::Client, input: &Value) -> Result<Value> {
        let kind = input
            .get("kind")
            .and_then(Value::as_str)
            .and_then(ProviderKind::parse)
            .filter(|kind| kind.base_url_required())
            .ok_or_else(|| invalid("kind", "Only providers at an own address can be asked before they are saved."))?;
        let base_url = Self::checked_base_url(kind, Self::text_field(input, "baseUrl", 2048)?.flatten())?;
        let api_key = Self::text_field(input, "apiKey", 4096)?.flatten();
        let endpoint = Endpoint { kind, base_url, api_key };
        let models = provider::models(http, &endpoint).await?;
        Ok(json!({ "models": models, "model": null, "fastModel": null }))
    }

    // -------------------------------------------------------------- settings

    fn choice(&self, key: &str) -> Result<Option<Choice>> {
        Ok(self
            .store
            .assist_setting(key)?
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| Choice::from_value(&value)))
    }

    pub fn auto_labels_on(&self) -> Result<bool> {
        Ok(self.store.assist_setting("autoLabels")?.as_deref() == Some("true"))
    }

    /// What a feature really uses: its choice, the default, then the first usable provider.
    pub fn effective(&self, feature: Feature) -> Result<Option<Effective>> {
        let providers = self.providers()?;
        let usable = |id: &str| providers.iter().find(|p| p.id == id && Self::usable(p));
        let chosen = [self.choice(&format!("features/{}", feature.as_str()))?, self.choice("default")?]
            .into_iter()
            .flatten()
            .find_map(|choice| usable(&choice.provider_id).map(|p| (p.clone(), choice.model)));
        let (record, model) = match chosen {
            Some(found) => found,
            None => match providers.iter().find(|p| Self::usable(p)) {
                Some(first) => (first.clone(), None),
                None => return Ok(None),
            },
        };
        let Some(kind) = Self::kind_of(&record) else { return Ok(None) };
        let (default_model, default_fast) = kind.default_models();
        let model = model.or_else(|| match feature {
            Feature::Compose => record.model.clone().or(default_model.map(String::from)),
            _ => record
                .fast_model
                .clone()
                .or_else(|| record.model.clone())
                .or(default_fast.map(String::from))
                .or(default_model.map(String::from)),
        });
        Ok(model.map(|model| Effective { provider: record, kind, model }))
    }

    /// Per feature whether it can be used; `None` when none can.
    pub fn features(&self) -> Result<Option<Value>> {
        let mut flags = Map::new();
        let mut any = false;
        for feature in Feature::ALL {
            let on = self.effective(feature)?.is_some();
            any |= on;
            flags.insert(feature.as_str().into(), Value::Bool(on));
        }
        Ok(any.then_some(Value::Object(flags)))
    }

    /// The settings as the server's `AssistSettings` object.
    pub fn settings_json(&self) -> Result<Value> {
        let mut features = Map::new();
        let mut effective = Map::new();
        for feature in Feature::ALL {
            let key = format!("features/{}", feature.as_str());
            features.insert(feature.as_str().into(), self.choice(&key)?.map_or(Value::Null, |c| c.to_value()));
            effective.insert(
                feature.as_str().into(),
                match self.effective(feature)? {
                    Some(e) => json!({
                        "providerId": e.provider.id,
                        "providerName": e.provider.name,
                        "model": e.model,
                        "scope": "personal",
                    }),
                    None => Value::Null,
                },
            );
        }
        Ok(json!({
            "id": "singleton",
            "default": self.choice("default")?.map_or(Value::Null, |c| c.to_value()),
            "features": features,
            "autoLabels": self.auto_labels_on()?,
            "effective": effective,
        }))
    }

    /// Applies the server's update shape: `default`, `features/<f>` (or a whole `features` map) and
    /// `autoLabels`.
    pub fn update_settings(&self, patch: &Value) -> Result<()> {
        let patch = patch.as_object().ok_or_else(|| Error::assist("invalidArguments", "No settings given."))?;
        let providers = self.providers()?;
        let mut changes: Vec<(String, Option<String>)> = Vec::new();
        let choice_change = |key: String, value: &Value| -> Result<(String, Option<String>)> {
            if value.is_null() {
                return Ok((key, None));
            }
            let choice = Choice::from_value(value).ok_or_else(|| invalid(&key, "This isn't a provider and model."))?;
            if !providers.iter().any(|p| p.id == choice.provider_id) {
                return Err(invalid(&key, "This provider doesn't exist on this device."));
            }
            let text = choice.to_value().to_string();
            Ok((key, Some(text)))
        };
        for (key, value) in patch {
            match key.as_str() {
                "default" => changes.push(choice_change("default".into(), value)?),
                "features" => {
                    for (feature, value) in value.as_object().into_iter().flatten() {
                        let feature = Feature::parse(feature).ok_or_else(|| invalid("features", "Unknown feature."))?;
                        changes.push(choice_change(format!("features/{}", feature.as_str()), value)?);
                    }
                }
                "autoLabels" => {
                    let on = value.as_bool().ok_or_else(|| invalid("autoLabels", "This must be on or off."))?;
                    changes.push(("autoLabels".into(), Some(on.to_string())));
                }
                other => match other.strip_prefix("features/").and_then(Feature::parse) {
                    Some(feature) => changes.push(choice_change(format!("features/{}", feature.as_str()), value)?),
                    None => return Err(invalid(other, "This setting doesn't exist.")),
                },
            }
        }
        for (key, value) in changes {
            self.store.set_assist_setting(&key, value.as_deref())?;
        }
        Ok(())
    }

    // ----------------------------------------------------------------- labels

    pub fn labels(&self) -> Result<Vec<Label>> {
        self.store.assist_labels()
    }

    fn check_label(&self, label: &Label, own_id: Option<&str>) -> Result<()> {
        let chars = label.name.chars().count();
        if chars == 0 || chars > MAX_LABEL_NAME_CHARS {
            return Err(invalid("name", "A label needs a name of 1 to 40 characters."));
        }
        if label.description.chars().count() > MAX_LABEL_DESCRIPTION_CHARS {
            return Err(invalid("description", "The description is too long."));
        }
        if let Some(color) = &label.color
            && !(color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit()))
        {
            return Err(invalid("color", "This isn't a color."));
        }
        let lower = label.name.to_lowercase();
        if self.labels()?.iter().any(|other| Some(other.id.as_str()) != own_id && other.name.to_lowercase() == lower) {
            return Err(invalid("name", "There is a label with this name already."));
        }
        Ok(())
    }

    fn label_input(input: &Value, base: Label) -> Result<Label> {
        let text = |key: &str| input.get(key).and_then(Value::as_str).map(|t| t.trim().to_string());
        let mut label = base;
        if let Some(name) = text("name") {
            label.name = name.chars().filter(|c| !c.is_control()).collect();
        }
        if let Some(description) = text("description") {
            label.description = description;
        }
        match input.get("color") {
            Some(Value::Null) => label.color = None,
            Some(Value::String(color)) => label.color = Some(color.to_lowercase()),
            _ => {}
        }
        Ok(label)
    }

    pub fn create_label(&self, input: &Value) -> Result<Label> {
        let labels = self.labels()?;
        if labels.len() >= MAX_LABELS {
            return Err(Error::assist("overQuota", "There are as many labels as there may be."));
        }
        let empty = Label {
            id: String::new(),
            name: String::new(),
            description: String::new(),
            keyword: String::new(),
            color: None,
        };
        let mut label = Self::label_input(input, empty)?;
        self.check_label(&label, None)?;
        let taken = |keyword: &str| labels.iter().any(|l| l.keyword == keyword);
        let mut keyword = label_keyword(&label.name);
        if keyword.is_empty() || taken(&keyword) {
            keyword = (1..).map(|n| format!("label-{n}")).find(|k| !taken(k)).unwrap_or_default();
        }
        label.keyword = keyword;
        label.id = format!("g{}", uuid::Uuid::new_v4().simple());
        self.store.insert_assist_label(&label, now())?;
        Ok(label)
    }

    pub fn update_label(&self, id: &str, patch: &Value) -> Result<()> {
        let current = self
            .labels()?
            .into_iter()
            .find(|l| l.id == id)
            .ok_or_else(|| Error::assist("notFound", "This label no longer exists."))?;
        let label = Self::label_input(patch, current)?;
        self.check_label(&label, Some(id))?;
        self.store.update_assist_label(&label)?;
        Ok(())
    }

    // ------------------------------------------------------------------ usage

    /// The main call of a request as the heuristic expects it: the prompt with the API's framing,
    /// a typical answer of `output` tokens, and thinking for a model that thinks.
    pub fn heuristic(&self, effective: &Effective, prompt: &Prompt, output: u64) -> Call {
        let price = self.price_of(&effective.provider, &effective.model);
        let sheet = price.as_ref().map(|price| &price.sheet);
        let listed = sheet.is_some_and(|sheet| sheet.supports_reasoning);
        let reasons = estimate::thinks(effective.kind, &effective.model, listed);
        estimate::heuristic_call(effective.kind, prompt, output, reasons, sheet.and_then(|s| s.max_output_tokens))
    }

    /// What recent real calls teach about this provider, model and feature; `None` with too few.
    pub fn calibration(&self, effective: &Effective, feature: Feature) -> Result<Option<estimate::Calibration>> {
        let samples = self.store.assist_calibration(&effective.provider.id, &effective.model, feature.as_str())?;
        Ok(estimate::calibration(&samples))
    }

    /// Every call a request of `feature` with this prompt makes, calibrated where possible. On this
    /// device that is one: pictures are read here (for free), a thread is summarized in one go,
    /// and an answer that isn't usable is not asked for again. A request refused for its answer
    /// format is asked once more, but refused requests cost nothing.
    pub fn estimate(&self, effective: &Effective, feature: Feature, prompt: &Prompt, output: u64) -> Result<Estimate> {
        let call = self.heuristic(effective, prompt, output);
        Ok(match self.calibration(effective, feature)? {
            Some(calibration) => Estimate { calls: vec![call.calibrated(&calibration)], calibrated: true },
            None => Estimate { calls: vec![call], calibrated: false },
        })
    }

    /// Counts a request: its tokens and what it really cost; with `expected` (the heuristic's
    /// call), also for calibration.
    pub fn record_usage(
        &self,
        effective: &Effective,
        feature: Feature,
        answer: Option<&ChatAnswer>,
        expected: Option<&Call>,
    ) -> Result<()> {
        let usage = answer.and_then(|a| a.usage);
        let estimate = answer.map_or(0, |a| a.text.chars().count() as u64 / 4);
        let input_tokens = usage.map_or(0, |u| u.input_tokens);
        let output_tokens = usage.map_or(estimate, |u| u.output_tokens);
        // What it cost: the provider's own figure, else today's price of what it reported; unknown
        // when the provider didn't say how much it read.
        let price = self.price_of(&effective.provider, &effective.model);
        let cost_usd = match (usage, price) {
            (Some(usage), _) if usage.cost_usd.is_some() => usage.cost_usd,
            (Some(usage), Some(price)) => Some(price.actual_usd(&usage)),
            (None, Some(price)) if price.source == prices::PriceSource::Free => Some(0.0),
            _ => None,
        };
        let day = utc_day(now());
        self.store.add_assist_usage(&UsageRecord {
            day,
            provider_id: effective.provider.id.clone(),
            provider_name: effective.provider.name.clone(),
            feature: feature.as_str().into(),
            requests: 1,
            input_tokens,
            output_tokens,
            reasoning_tokens: usage.map_or(0, |u| u.reasoning_tokens),
            cached_tokens: usage.map_or(0, |u| u.cached_tokens),
            calls: answer.map_or(1, |a| a.calls.max(1)),
            cost_usd,
        })?;
        if let (Some(usage), Some(expected)) = (usage, expected)
            && usage.input_tokens > 0
        {
            self.store.add_assist_calibration(&CalibrationRecord {
                provider_id: effective.provider.id.clone(),
                model: effective.model.clone(),
                feature: feature.as_str().into(),
                sample: Sample {
                    estimated_input: expected.input,
                    estimated_output: expected.output,
                    estimated_reasoning: expected.reasoning,
                    input: usage.input_tokens,
                    output: usage.output_tokens,
                    reasoning: usage.reasoning_tokens,
                },
                created_at: now(),
            })?;
        }
        let _ = self.store.forget_assist_usage_before(&utc_day(now() - USAGE_DAYS * 86_400));
        Ok(())
    }

    /// Requests for a feature today, over every provider.
    pub fn requests_today(&self, feature: Feature) -> Result<u64> {
        let today = utc_day(now());
        Ok(self
            .store
            .assist_usage(&today)?
            .iter()
            .filter(|row| row.feature == feature.as_str())
            .map(|row| row.requests)
            .sum())
    }

    /// Usage as the server's `Assist/usage` answer; this device has no daily limits. Costs are in
    /// `currency` by today's rates, `null` where the price was unknown when the request was made.
    pub fn usage_json(&self, days: u32, currency: &str) -> Result<Value> {
        let days = i64::from(days.clamp(1, 90));
        let since = utc_day(now() - (days - 1) * 86_400);
        let today = utc_day(now());
        let rows = self.store.assist_usage(&since)?;
        let none = PriceTable::default();
        let table = self.prices.as_deref().unwrap_or(&none);
        let cost = |usd: Option<f64>| table.cost_json(usd, currency);
        let mut per_provider: HashMap<String, (String, u64, u64, Option<f64>)> = HashMap::new();
        for row in rows.iter().filter(|row| row.day == today) {
            let entry = per_provider.entry(row.provider_id.clone()).or_insert((row.provider_name.clone(), 0, 0, None));
            entry.1 += row.requests;
            entry.2 += row.input_tokens + row.output_tokens + row.reasoning_tokens;
            if let Some(usd) = row.cost_usd {
                entry.3 = Some(entry.3.unwrap_or(0.0) + usd);
            }
        }
        let mut today_list: Vec<Value> = per_provider
            .into_iter()
            .map(|(id, (name, requests, tokens, usd))| {
                json!({ "providerId": id, "providerName": name, "requests": requests, "tokens": tokens,
                        "requestsPerDay": null, "tokensPerDay": null, "cost": cost(usd) })
            })
            .collect();
        today_list.sort_by(|a, b| a["providerName"].as_str().cmp(&b["providerName"].as_str()));
        let days: Vec<Value> = rows
            .iter()
            .map(|row| {
                json!({ "day": row.day, "providerId": row.provider_id, "providerName": row.provider_name,
                        "feature": row.feature, "requests": row.requests, "inputTokens": row.input_tokens,
                        "outputTokens": row.output_tokens, "reasoningTokens": row.reasoning_tokens,
                        "cost": cost(row.cost_usd) })
            })
            .collect();
        Ok(json!({ "days": days, "today": today_list }))
    }

    // ---------------------------------------------------------------- asking

    /// Asks the model a feature uses, counts the request and answers with who answered.
    /// `typical_output` is the answer's expected size (see `estimate::output_tokens`), which the
    /// real call is compared with to calibrate later estimates.
    pub async fn ask(
        &self,
        http: &reqwest::Client,
        feature: Feature,
        prompt: &Prompt,
        typical_output: u64,
        on_delta: Option<&mut (dyn FnMut(&str) + Send)>,
    ) -> Result<(ChatAnswer, Effective)> {
        let effective = self
            .effective(feature)?
            .ok_or_else(|| Error::assist("assistUnavailable", "No provider set up on this device can do this."))?;
        let endpoint = self.endpoint(&effective.provider)?;
        let request = ChatRequest {
            model: effective.model.clone(),
            system: prompt.system.clone(),
            messages: vec![ChatMessage { role: Role::User, content: prompt.user.clone() }],
            max_output_tokens: prompt.max_tokens,
            json_schema: prompt.schema.as_ref().map(|(name, schema)| JsonSchema { name, schema: schema.clone() }),
            temperature: None,
        };
        let expected = self.heuristic(&effective, prompt, typical_output);
        let answer = provider::chat(http, &endpoint, &request, on_delta).await;
        self.record_usage(&effective, feature, answer.as_ref().ok(), Some(&expected))?;
        Ok((answer?, effective))
    }
}

/// Who answered, as every answer of the server says.
pub fn answer_json(effective: &Effective, answer: &ChatAnswer) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("providerId".into(), json!(effective.provider.id));
    out.insert("providerName".into(), json!(effective.provider.name));
    out.insert("model".into(), json!(effective.model));
    out.insert("usage".into(), answer.usage.map_or(Value::Null, |u| json!(u)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemorySecrets;

    fn device() -> (Store, MemorySecrets) {
        (Store::open_in_memory().unwrap(), MemorySecrets::default())
    }

    /// Made up for the tests.
    const TEST_KEY: &str = "sk-geheim-a1b2"; // gitleaks:allow

    #[test]
    fn keys_go_to_the_keychain_and_only_a_hint_to_the_page() {
        let (store, secrets) = device();
        let device = Device { store: &store, secrets: &secrets, prices: None };
        let created = device
            .create_provider(&json!({ "name": "Mistral", "kind": "mistral", "apiKey": format!(" {TEST_KEY} ") }))
            .unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        assert_eq!(created["keyHint"], "…a1b2");
        assert_eq!(created["hasKey"], true);
        assert!(!created.to_string().contains("geheim"));
        assert!(!device.providers_json().unwrap().to_string().contains("geheim"));
        assert_eq!(secrets.get(&secret_id(&id)).unwrap(), Secret::ApiKey { api_key: TEST_KEY.into() });
        assert_eq!(device.endpoint(&device.provider(&id).unwrap()).unwrap().api_key.as_deref(), Some(TEST_KEY));

        // Leaving the key out keeps it; "" removes it.
        device.update_provider(&id, &json!({ "name": "Mistral EU" })).unwrap();
        assert!(secrets.get(&secret_id(&id)).is_ok());
        device.update_provider(&id, &json!({ "apiKey": "" })).unwrap();
        assert!(secrets.get(&secret_id(&id)).is_err());
        assert_eq!(device.features().unwrap(), None, "Mistral without a key can't be used");

        device.delete_provider(&id).unwrap();
        assert!(device.providers().unwrap().is_empty());
    }

    #[test]
    fn addresses_kinds_and_limits_are_checked() {
        let (store, secrets) = device();
        let device = Device { store: &store, secrets: &secrets, prices: None };
        let refused = |input: Value| device.create_provider(&input).unwrap_err();
        assert_eq!(refused(json!({ "name": "C", "kind": "chatgpt" })).assist.unwrap().properties, ["kind"]);
        assert_eq!(
            refused(json!({ "name": "", "kind": "ollama", "baseUrl": "http://127.0.0.1:11434" })).assist_kind(),
            Some("invalidProperties")
        );
        let plain = refused(json!({ "name": "O", "kind": "ollama", "baseUrl": "http://203.0.113.5:11434" }));
        assert_eq!(plain.assist.unwrap().properties, ["baseUrl"], "keys never travel unencrypted over the internet");
        assert_eq!(refused(json!({ "name": "O", "kind": "ollama" })).assist.unwrap().properties, ["baseUrl"]);
        assert_eq!(
            refused(json!({ "name": "G", "kind": "gemini", "baseUrl": "https://gemini.example.com/v1" }))
                .assist
                .unwrap()
                .properties,
            ["baseUrl"]
        );
        let ollama = device
            .create_provider(&json!({ "name": "Ollama", "kind": "ollama", "baseUrl": "http://192.168.1.20:11434", "model": "llama3" }))
            .unwrap();
        assert_eq!(ollama["connected"], true, "Ollama needs no key");
        for n in 1..MAX_PROVIDERS {
            device.create_provider(&json!({ "name": format!("P{n}"), "kind": "openai" })).unwrap();
        }
        assert_eq!(refused(json!({ "name": "one more", "kind": "openai" })).assist_kind(), Some("overQuota"));
    }

    #[test]
    fn choices_fall_back_like_the_servers() {
        let (store, secrets) = device();
        let device = Device { store: &store, secrets: &secrets, prices: None };
        assert_eq!(device.features().unwrap(), None);
        let local = device
            .create_provider(&json!({ "name": "Ollama", "kind": "ollama", "baseUrl": "http://localhost:11434", "model": "big", "fastModel": "small" }))
            .unwrap();
        let local_id = local["id"].as_str().unwrap();
        let openai = device.create_provider(&json!({ "name": "OpenAI", "kind": "openai", "apiKey": "sk-1" })).unwrap();
        let openai_id = openai["id"].as_str().unwrap();

        // The first usable provider, with its models per feature.
        assert_eq!(device.effective(Feature::Compose).unwrap().unwrap().model, "big");
        assert_eq!(device.effective(Feature::Summarize).unwrap().unwrap().model, "small");
        device.update_settings(&json!({ "default": { "providerId": openai_id, "model": null } })).unwrap();
        assert_eq!(device.effective(Feature::Compose).unwrap().unwrap().model, "gpt-5-mini");
        assert_eq!(device.effective(Feature::SpamCheck).unwrap().unwrap().model, "gpt-5-nano");
        device.update_settings(&json!({ "features/spamCheck": { "providerId": local_id, "model": "tiny" } })).unwrap();
        assert_eq!(device.effective(Feature::SpamCheck).unwrap().unwrap().model, "tiny");
        let settings = device.settings_json().unwrap();
        assert_eq!(settings["effective"]["spamCheck"]["providerName"], "Ollama");
        assert_eq!(settings["autoLabels"], false);

        assert!(device.update_settings(&json!({ "default": { "providerId": "nope" } })).is_err());
        device.update_settings(&json!({ "autoLabels": true })).unwrap();
        assert!(device.auto_labels_on().unwrap());

        // Deleting a provider drops the choices that name it.
        device.delete_provider(local_id).unwrap();
        assert_eq!(device.settings_json().unwrap()["features"]["spamCheck"], Value::Null);
        assert_eq!(device.features().unwrap().unwrap()["compose"], true);
    }

    #[test]
    fn labels_get_keywords_once() {
        let (store, secrets) = device();
        let device = Device { store: &store, secrets: &secrets, prices: None };
        let label = device
            .create_label(&json!({ "name": "Bestellungen & Versand", "description": "Pakete", "color": "#FF66AA" }))
            .unwrap();
        assert_eq!((label.keyword.as_str(), label.color.as_deref()), ("bestellungen-versand", Some("#ff66aa")));
        assert_eq!(device.create_label(&json!({ "name": "旅行" })).unwrap().keyword, "label-1");
        assert!(device.create_label(&json!({ "name": "bestellungen & versand" })).is_err(), "names are unique");
        assert!(device.create_label(&json!({ "name": "X", "color": "red" })).is_err());
        device.update_label(&label.id, &json!({ "name": "Pakete" })).unwrap();
        let renamed = device.labels().unwrap().into_iter().find(|l| l.id == label.id).unwrap();
        assert_eq!((renamed.name.as_str(), renamed.keyword.as_str()), ("Pakete", "bestellungen-versand"));
    }
}
