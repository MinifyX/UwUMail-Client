//! The AI assistant for every mailbox (see `crate::assist`): a UwUMail account whose session has
//! `urn:uwumail:jmap:assist` asks its server, every other mailbox the providers set up on this
//! device. The page talks to one shape either way: the server's JMAP shapes, with the app's own
//! message, thread and account ids.

use std::sync::OnceLock;

use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use super::*;
use crate::assist::estimate::{self, Method};
use crate::assist::local::{self, Device, Effective};
use crate::assist::mail::{self, MailText};
use crate::assist::prices::PriceTable;
use crate::assist::prompts::{self, ComposeRequest, Prompt, SUBJECT_MARK};
use crate::assist::provider::{self, ProviderKind};
use crate::assist::validate::{self, EventContext};
use crate::assist::{Feature, Label, StreamEvent, StreamSink, discover, server, signals};
use crate::store::LabelLogRecord;

/// At most this much picture text goes along when the assistant reads a mail's appointments.
const IMAGE_TEXT_CHARS: usize = 8_000;

/// The scope id of what is kept on this device.
pub const DEVICE_SCOPE: &str = "device";
/// How long `assist_scopes` waits for one account's server.
const SERVER_WAIT: Duration = Duration::from_secs(10);
/// Mails labelled in one go, at most (`AssistLabel/apply`, and new mail per sync).
const LABELS_AT_ONCE: usize = 20;
/// Mails a conversation's summary reads, at most (the latest, oldest first).
const MAX_THREAD_MAILS: usize = 20;
/// Label log entries are kept this long.
const LOG_DAYS: i64 = 400;

/// New inbox mail of one account: (account id, message ids).
type LabelJob = (String, Vec<String>);

/// What the engine keeps for the assistant while it runs.
pub(super) struct AssistState {
    /// Streams the page may stop, by its stream id.
    streams: Mutex<HashMap<String, Arc<Notify>>>,
    /// The client for requests to providers (no redirects).
    http: OnceLock<reqwest::Client>,
    /// New inbox mail of mailboxes without a server assistant, for auto-labels.
    queue: mpsc::UnboundedSender<LabelJob>,
    queue_rx: Mutex<Option<mpsc::UnboundedReceiver<LabelJob>>>,
    /// The prices of this device's providers.
    pub(super) prices: super::price_ops::PriceState,
}

impl AssistState {
    pub(super) fn new() -> Self {
        let (queue, queue_rx) = mpsc::unbounded_channel();
        Self {
            streams: Mutex::new(HashMap::new()),
            http: OnceLock::new(),
            queue,
            queue_rx: Mutex::new(Some(queue_rx)),
            prices: super::price_ops::PriceState::new(),
        }
    }
}

/// Who answers for a mailbox.
enum Target {
    Server(Arc<JmapClient>),
    Device,
}

fn now_secs() -> i64 {
    now_millis() / 1000
}

fn text_arg<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty())
}

fn cancelled() -> Error {
    Error::assist("cancelled", "Stopped.")
}

/// Passes streamed text on, taking a `SUBJECT:` line off the start when one is asked for.
struct Relay {
    sink: StreamSink,
    head: String,
    in_head: bool,
    /// Right after a subject: the body's leading line breaks go.
    trim_start: bool,
}

impl Relay {
    fn new(sink: StreamSink, want_subject: bool) -> Self {
        Self { sink, head: String::new(), in_head: want_subject, trim_start: false }
    }

    fn push(&mut self, piece: &str) {
        if !self.in_head {
            let piece = if self.trim_start { piece.trim_start() } else { piece };
            if piece.is_empty() {
                return;
            }
            self.trim_start = false;
            (self.sink)(StreamEvent::Delta { text: piece.to_string() });
            return;
        }
        self.head.push_str(piece);
        let trimmed = self.head.trim_start();
        let upper: String = trimmed.chars().take(SUBJECT_MARK.len()).collect::<String>().to_ascii_uppercase();
        let could_be = SUBJECT_MARK.starts_with(&upper);
        if could_be && (upper.len() < SUBJECT_MARK.len() || !trimmed.contains('\n')) && self.head.chars().count() < 500
        {
            return;
        }
        self.flush();
    }

    fn flush(&mut self) {
        if !self.in_head {
            return;
        }
        self.in_head = false;
        let head = std::mem::take(&mut self.head);
        let (subject, body) = validate::split_subject(&head);
        match subject {
            Some(subject) => {
                (self.sink)(StreamEvent::Subject { subject });
                if body.is_empty() {
                    self.trim_start = true;
                } else {
                    (self.sink)(StreamEvent::Delta { text: body });
                }
            }
            None if !head.is_empty() => (self.sink)(StreamEvent::Delta { text: head }),
            None => {}
        }
    }
}

impl Engine {
    fn device(&self) -> Device<'_> {
        Device { store: &self.inner.store, secrets: &*self.inner.secrets, prices: self.known_prices() }
    }

    /// This device's assistant with prices fetched when due, for what shows a cost.
    async fn priced_device(&self) -> Device<'_> {
        let prices = self.current_prices().await;
        Device { store: &self.inner.store, secrets: &*self.inner.secrets, prices }
    }

    pub(super) fn assist_http(&self) -> Result<&reqwest::Client> {
        if let Some(http) = self.inner.assist.http.get() {
            return Ok(http);
        }
        let http = crate::assist::provider::http_client()?;
        Ok(self.inner.assist.http.get_or_init(|| http))
    }

    /// Who answers for a mailbox: its server when that has the assistant, else this device.
    async fn assist_target(&self, account_id: &str) -> Result<Target> {
        let account = self.inner.store.account(account_id)?;
        if account.protocol == Protocol::Jmap {
            let client = self.inner.jmap_client(account_id).await?;
            if server::options(&client).is_some() {
                return Ok(Target::Server(client));
            }
        }
        Ok(Target::Device)
    }

    async fn scope_target(&self, scope: &str) -> Result<Target> {
        if scope == DEVICE_SCOPE {
            return Ok(Target::Device);
        }
        match self.assist_target(scope).await? {
            Target::Server(client) => Ok(Target::Server(client)),
            Target::Device => Err(Error::assist("assistUnavailable", "This mailbox's server has no assistant.")),
        }
    }

    fn assist_changed(&self, account_id: Option<&str>) {
        self.inner.emit(EngineEvent::AssistChanged { account_id: account_id.map(String::from) });
    }

    /// The mailboxes this device's assistant serves (every one whose server has none), and the
    /// UwUMail accounts with their servers' assistant. Servers that can't be asked now are left out.
    async fn assist_split(&self) -> Result<(Vec<(String, Arc<JmapClient>)>, Vec<String>)> {
        let accounts = self.inner.store.accounts()?;
        let checks = accounts.iter().map(|account| async move {
            let target = tokio::time::timeout(SERVER_WAIT, self.assist_target(&account.id)).await;
            (account, target)
        });
        let mut servers = Vec::new();
        let mut device = Vec::new();
        for (account, target) in futures::future::join_all(checks).await {
            match target {
                Ok(Ok(Target::Server(client))) => servers.push((account.id.clone(), client)),
                Ok(Ok(Target::Device)) => device.push(account.id.clone()),
                // A UwUMail server that can't be reached is not handed to this device's providers.
                _ if account.protocol == Protocol::Jmap => {}
                _ => device.push(account.id.clone()),
            }
        }
        Ok((servers, device))
    }

    /// Where the assistant's settings live: one scope per UwUMail account with the assistant, and
    /// this device for every other mailbox.
    pub async fn assist_scopes(&self) -> Result<Value> {
        let (servers, device) = self.assist_split().await?;
        let mut scopes: Vec<Value> = servers
            .iter()
            .map(|(id, client)| {
                json!({ "id": id, "kind": "server", "accountId": id, "accountIds": [id],
                        "options": server::options(client).cloned().unwrap_or(Value::Null) })
            })
            .collect();
        if !device.is_empty() {
            let features = self.device().features()?.unwrap_or_else(|| {
                Value::Object(Feature::ALL.iter().map(|f| (f.as_str().to_string(), Value::Bool(false))).collect())
            });
            scopes.push(json!({ "id": DEVICE_SCOPE, "kind": "device", "accountId": null, "accountIds": device,
                                "options": local::options(&features) }));
        }
        Ok(Value::Array(scopes))
    }

    /// Per feature whether the assistant can do it now for this mailbox; `None` without one.
    pub async fn assist_features(&self, account_id: &str) -> Result<Option<Value>> {
        match self.assist_target(account_id).await {
            Ok(Target::Server(client)) => Ok(server::features(&client)),
            Ok(Target::Device) => self.device().features(),
            // A server that can't be reached right now: nothing to offer.
            Err(error) if error.code == ErrorCode::ConnectionFailed => Ok(None),
            Err(error) => Err(error),
        }
    }

    // -------------------------------------------------------- providers

    pub async fn assist_providers(&self, scope: &str) -> Result<Value> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::providers(&client).await,
            Target::Device => self.priced_device().await.providers_json(),
        }
    }

    pub async fn assist_create_provider(&self, scope: &str, input: Value) -> Result<Value> {
        let created = match self.scope_target(scope).await? {
            Target::Server(client) => server::create_provider(&client, input).await?,
            Target::Device => self.device().create_provider(&input)?,
        };
        self.assist_changed(None);
        Ok(created)
    }

    pub async fn assist_update_provider(&self, scope: &str, provider_id: &str, patch: Value) -> Result<()> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::update_provider(&client, provider_id, patch).await?,
            Target::Device => self.device().update_provider(provider_id, &patch)?,
        }
        self.assist_changed(None);
        Ok(())
    }

    pub async fn assist_delete_provider(&self, scope: &str, provider_id: &str) -> Result<()> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::delete_provider(&client, provider_id).await?,
            Target::Device => self.device().delete_provider(provider_id)?,
        }
        self.assist_changed(None);
        Ok(())
    }

    pub async fn assist_models(&self, scope: &str, provider_id: &str) -> Result<Value> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::models(&client, provider_id).await,
            Target::Device => self.device().models(self.assist_http()?, provider_id).await,
        }
    }

    pub async fn assist_chatgpt_login(&self, scope: &str, provider_id: &str) -> Result<Value> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::chatgpt_login(&client, provider_id).await,
            Target::Device => Err(Error::not_supported("ChatGPT sign-in isn't offered on this device.")),
        }
    }

    pub async fn assist_chatgpt_poll(&self, scope: &str, provider_id: &str) -> Result<Value> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::chatgpt_poll(&client, provider_id).await,
            Target::Device => Err(Error::not_supported("ChatGPT sign-in isn't offered on this device.")),
        }
    }

    // --------------------------------------------------------- settings

    pub async fn assist_settings(&self, scope: &str) -> Result<Value> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::settings(&client).await,
            Target::Device => self.device().settings_json(),
        }
    }

    pub async fn assist_update_settings(&self, scope: &str, patch: Value) -> Result<()> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::update_settings(&client, patch).await?,
            Target::Device => self.device().update_settings(&patch)?,
        }
        self.assist_changed(None);
        Ok(())
    }

    /// Usage per day, provider and feature; costs in `currency` (EUR when not given).
    pub async fn assist_usage(&self, scope: &str, days: Option<u32>, currency: Option<&str>) -> Result<Value> {
        let days = days.unwrap_or(30).clamp(1, 90);
        let currency = super::price_ops::currency(currency);
        match self.scope_target(scope).await? {
            Target::Server(client) => server::usage(&client, days, &currency).await,
            Target::Device => self.priced_device().await.usage_json(days, &currency),
        }
    }

    // ----------------------------------------------------------- labels

    pub async fn assist_labels(&self, scope: &str) -> Result<Value> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::labels(&client).await,
            Target::Device => Ok(serde_json::to_value(self.device().labels()?)?),
        }
    }

    pub async fn assist_create_label(&self, scope: &str, input: Value) -> Result<Value> {
        let created = match self.scope_target(scope).await? {
            Target::Server(client) => server::create_label(&client, input).await?,
            Target::Device => serde_json::to_value(self.device().create_label(&input)?)?,
        };
        self.assist_changed(None);
        Ok(created)
    }

    pub async fn assist_update_label(&self, scope: &str, label_id: &str, patch: Value) -> Result<()> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::update_label(&client, label_id, patch).await?,
            Target::Device => self.device().update_label(label_id, &patch)?,
        }
        self.assist_changed(None);
        Ok(())
    }

    /// Deletes a label. On this device its keyword comes off the mail the assistant labelled with
    /// it (as far as the servers take that) and its log goes.
    pub async fn assist_delete_label(&self, scope: &str, label_id: &str) -> Result<()> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::delete_label(&client, label_id).await?,
            Target::Device => {
                let label = self
                    .device()
                    .labels()?
                    .into_iter()
                    .find(|l| l.id == label_id)
                    .ok_or_else(|| Error::assist("notFound", "This label no longer exists."))?;
                let labelled: Vec<String> = self
                    .inner
                    .store
                    .label_log(None, 500)?
                    .into_iter()
                    .filter(|entry| entry.label_id == label.id && !entry.undone)
                    .map(|entry| entry.message_id)
                    .collect();
                if !labelled.is_empty()
                    && let Err(error) = self.set_keywords(&labelled, &[(label.keyword.clone(), false)].into()).await
                {
                    tracing::debug!("Couldn't take a deleted label off: {error}");
                }
                self.inner.store.delete_assist_label(&label.id)?;
            }
        }
        self.assist_changed(None);
        Ok(())
    }

    /// Server email ids of messages of one account, with the way back.
    fn remote_ids(&self, account_id: &str, message_ids: &[String]) -> Result<Vec<(String, String)>> {
        Ok(self
            .inner
            .store
            .locations(message_ids)?
            .into_iter()
            .filter(|l| l.account_id == account_id)
            .filter_map(|l| l.remote_id.map(|remote| (l.id, remote)))
            .collect())
    }

    fn remote_id(&self, message_id: &str) -> Result<(String, String)> {
        let location = self
            .inner
            .store
            .locations(&[message_id.to_string()])?
            .pop()
            .ok_or_else(|| Error::assist("notFound", "This message no longer exists."))?;
        let remote =
            location.remote_id.ok_or_else(|| Error::assist("notFound", "The server doesn't know this mail."))?;
        Ok((location.account_id, remote))
    }

    /// Labels the model set, newest first, with the app's message ids.
    pub async fn assist_label_log(
        &self,
        scope: &str,
        message_ids: Option<Vec<String>>,
        limit: Option<u32>,
    ) -> Result<Value> {
        let limit = limit.unwrap_or(100).clamp(1, 500);
        match self.scope_target(scope).await? {
            Target::Server(client) => {
                let pairs = match &message_ids {
                    Some(ids) => Some(self.remote_ids(scope, ids)?),
                    None => None,
                };
                let remote: Option<Vec<String>> = pairs.as_ref().map(|p| p.iter().map(|(_, r)| r.clone()).collect());
                let entries = server::label_log(&client, remote.as_deref(), limit).await?;
                let wanted: Vec<String> =
                    entries.iter().filter_map(|e| e.get("emailId").and_then(Value::as_str).map(String::from)).collect();
                let local = self.inner.store.ids_by_remote(scope, &wanted)?;
                Ok(Value::Array(
                    entries
                        .into_iter()
                        .filter_map(|mut entry| {
                            let remote = entry.get("emailId").and_then(Value::as_str)?;
                            let id = local.get(remote)?.clone();
                            entry["emailId"] = Value::String(id);
                            Some(entry)
                        })
                        .collect(),
                ))
            }
            Target::Device => {
                let entries = self.inner.store.label_log(message_ids.as_deref(), limit)?;
                Ok(Value::Array(entries.iter().map(log_json).collect()))
            }
        }
    }

    pub async fn assist_undo_labels(&self, scope: &str, log_ids: &[String]) -> Result<()> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::undo_labels(&client, log_ids).await?,
            Target::Device => {
                for entry in self.inner.store.label_log_entries(log_ids)? {
                    if entry.undone {
                        continue;
                    }
                    self.set_keywords(
                        std::slice::from_ref(&entry.message_id),
                        &[(entry.keyword.clone(), false)].into(),
                    )
                    .await?;
                    self.inner.store.mark_label_undone(&entry.id)?;
                }
            }
        }
        self.assist_changed(None);
        Ok(())
    }

    /// Asks for labels now (at most 20 mails): label ids per message id.
    pub async fn assist_apply_labels(&self, message_ids: &[String]) -> Result<Value> {
        let message_ids: Vec<String> = message_ids.iter().take(LABELS_AT_ONCE).cloned().collect();
        let mut by_account: HashMap<String, Vec<String>> = HashMap::new();
        for (id, account_id, _) in self.inner.store.message_roles(&message_ids)? {
            by_account.entry(account_id).or_default().push(id);
        }
        let mut out = Map::new();
        for (account_id, ids) in by_account {
            match self.assist_target(&account_id).await? {
                Target::Server(client) => {
                    let pairs = self.remote_ids(&account_id, &ids)?;
                    let remote: Vec<String> = pairs.iter().map(|(_, r)| r.clone()).collect();
                    let labeled = server::apply_labels(&client, &remote).await?;
                    for (local, remote) in pairs {
                        if let Some(labels) = labeled.get(&remote) {
                            out.insert(local, labels.clone());
                        }
                    }
                }
                Target::Device => {
                    for id in ids {
                        let labels = self.label_on_device(&id).await?;
                        out.insert(id, json!(labels));
                    }
                }
            }
        }
        self.assist_changed(None);
        Ok(Value::Object(out))
    }

    /// The newest mails of a scope's inboxes.
    pub async fn assist_recent_inbox(&self, scope: &str, limit: u32) -> Result<Vec<String>> {
        let accounts = if scope == DEVICE_SCOPE { self.assist_split().await?.1 } else { vec![scope.to_string()] };
        self.inner.store.recent_inbox(&accounts, limit)
    }

    // ---------------------------------------------------------- streams

    /// Stops a streamed answer the page no longer waits for.
    pub fn assist_cancel(&self, stream_id: &str) {
        if let Some(stop) = self.inner.assist.streams.lock().unwrap().get(stream_id) {
            stop.notify_one();
        }
    }

    /// Runs `work`, which the page may stop through `stream_id`.
    async fn stoppable<T>(&self, stream_id: Option<&str>, work: impl Future<Output = Result<T>>) -> Result<T> {
        let Some(stream_id) = stream_id else { return work.await };
        let stop = Arc::new(Notify::new());
        self.inner.assist.streams.lock().unwrap().insert(stream_id.to_string(), Arc::clone(&stop));
        let result = tokio::select! {
            result = work => result,
            () = stop.notified() => Err(cancelled()),
        };
        self.inner.assist.streams.lock().unwrap().remove(stream_id);
        result
    }

    // ---------------------------------------------------------- compose

    /// Writes or rewrites a text for a draft of `account_id`; the answer is only ever a proposal.
    pub async fn assist_compose(
        &self,
        account_id: &str,
        request: Value,
        stream_id: Option<&str>,
        sink: Option<StreamSink>,
    ) -> Result<Value> {
        let work = async {
            match self.assist_target(account_id).await? {
                Target::Server(client) => {
                    let mut arguments = request.clone();
                    if let Some(reply) = text_arg(&request, "replyToEmailId") {
                        arguments["replyToEmailId"] = match self.remote_id(reply) {
                            Ok((account, remote)) if account == account_id => Value::String(remote),
                            _ => Value::Null,
                        };
                    }
                    server::stream_or_call(&client, "Assist/compose", arguments, sink.clone()).await
                }
                Target::Device => self.compose_on_device(account_id, &request, sink.clone()).await,
            }
        };
        self.stoppable(stream_id, work).await
    }

    /// The prompt of a compose request on this device, and whether it asks for a subject. With
    /// `download`, the mail replied to is fetched when only its preview is stored.
    async fn compose_prompt(&self, account_id: &str, request: &Value, download: bool) -> Result<(Prompt, bool)> {
        let mode = text_arg(request, "mode").unwrap_or("write");
        if !matches!(mode, "write" | "rewrite" | "adjust") {
            return Err(Error::assist("invalidArguments", "Unknown way of writing."));
        }
        let instruction = text_arg(request, "instruction");
        let text = request.get("text").and_then(Value::as_str).filter(|t| !t.trim().is_empty());
        let preset = text_arg(request, "preset");
        if instruction.is_some_and(|i| i.chars().count() > local::MAX_INSTRUCTION_CHARS)
            || text.is_some_and(|t| t.chars().count() > local::MAX_TEXT_CHARS)
        {
            return Err(Error::assist("invalidArguments", "The text is too long for the assistant."));
        }
        match mode {
            "write" if instruction.is_none() => return Err(Error::assist("invalidArguments", "Say what to write.")),
            "adjust" if instruction.is_none() || text.is_none() => {
                return Err(Error::assist("invalidArguments", "Say what to change in the draft."));
            }
            "rewrite" if text.is_none() || prompts::preset_instruction(preset.unwrap_or(""), None).is_none() => {
                return Err(Error::assist("invalidArguments", "There is nothing to rewrite."));
            }
            _ => {}
        }
        let reply_to = match text_arg(request, "replyToEmailId") {
            Some(id) => self.stored_mail(id, mail::MAX_MAIL_CHARS, download).await.ok(),
            None => None,
        };
        let account = self.inner.store.account(account_id)?;
        let sender = mail::addresses(&[sender(&account)]);
        let today = chrono::Utc::now().format("%A, %Y-%m-%d").to_string();
        let want_subject = mode == "write" && request.get("wantSubject").and_then(Value::as_bool) == Some(true);
        let prompt = prompts::compose(&ComposeRequest {
            mode,
            instruction,
            preset,
            target_language: text_arg(request, "targetLanguage"),
            text,
            subject: text_arg(request, "subject"),
            reply_to: reply_to.as_ref(),
            want_subject,
            language: text_arg(request, "language"),
            sender: &sender,
            today: &today,
        });
        Ok((prompt, want_subject))
    }

    async fn compose_on_device(&self, account_id: &str, request: &Value, sink: Option<StreamSink>) -> Result<Value> {
        let (prompt, want_subject) = self.compose_prompt(account_id, request, true).await?;
        let mut relay = sink.map(|sink| Relay::new(sink, want_subject));
        let streaming = relay.is_some();
        let (answer, effective) = {
            let mut forward = |piece: &str| {
                if let Some(relay) = relay.as_mut() {
                    relay.push(piece);
                }
            };
            let on_delta: Option<&mut (dyn FnMut(&str) + Send)> = if streaming { Some(&mut forward) } else { None };
            let typical = estimate::output_tokens(compose_answer(request), &prompt);
            self.device().ask(self.assist_http()?, Feature::Compose, &prompt, typical, on_delta).await?
        };
        if let Some(relay) = relay.as_mut() {
            relay.flush();
        }
        let (subject, text) =
            if want_subject { validate::split_subject(&answer.text) } else { (None, answer.text.trim().to_string()) };
        let mut out = local::answer_json(&effective, &answer);
        out.insert("text".into(), json!(text));
        out.insert("subject".into(), json!(subject));
        Ok(Value::Object(out))
    }

    // -------------------------------------------------------- summarize

    /// Summarizes a mail (`emailId`) or a conversation (`threadId`), both the app's ids.
    pub async fn assist_summarize(
        &self,
        request: Value,
        stream_id: Option<&str>,
        sink: Option<StreamSink>,
    ) -> Result<Value> {
        let email_id = text_arg(&request, "emailId").map(String::from);
        let thread_id = text_arg(&request, "threadId").map(String::from);
        let language = text_arg(&request, "language").map(String::from);
        let work = async {
            let messages = match (&email_id, &thread_id) {
                (Some(id), _) => self.get_thread(&format!("m:{id}"), true).await?.messages,
                (None, Some(thread)) => self.get_thread(thread, true).await?.messages,
                (None, None) => return Err(Error::assist("invalidArguments", "Nothing to summarize.")),
            };
            let last = messages.last().ok_or_else(|| Error::assist("notFound", "This mail no longer exists."))?;
            let mut answer = match self.assist_target(&last.account_id).await? {
                Target::Server(client) => {
                    let (_, remote) = self.remote_id(&last.id)?;
                    let arguments = if email_id.is_some() {
                        json!({ "emailId": remote, "threadId": null, "language": language })
                    } else {
                        let responses = client
                            .call(vec![(
                                "Email/get",
                                json!({ "accountId": client.account_id(), "ids": [remote], "properties": ["threadId"] }),
                            )])
                            .await?;
                        let server_thread =
                            responses.get(0, "Email/get")?.pointer("/list/0/threadId").cloned().ok_or_else(|| {
                                Error::assist("notFound", "The server doesn't know this conversation.")
                            })?;
                        json!({ "emailId": null, "threadId": server_thread, "language": language })
                    };
                    server::stream_or_call(&client, "Assist/summarize", arguments, sink.clone()).await?
                }
                Target::Device => {
                    let (prompt, mails) = summarize_prompt(&messages, language.as_deref());
                    let typical = estimate::output_tokens(estimate::Answer::Summary { mails }, &prompt);
                    let mut forward = |piece: &str| {
                        if let Some(sink) = &sink {
                            sink(StreamEvent::Delta { text: piece.to_string() });
                        }
                    };
                    let on_delta: Option<&mut (dyn FnMut(&str) + Send)> =
                        if sink.is_some() { Some(&mut forward) } else { None };
                    let (answer, effective) =
                        self.device().ask(self.assist_http()?, Feature::Summarize, &prompt, typical, on_delta).await?;
                    let mut out = local::answer_json(&effective, &answer);
                    out.insert("summary".into(), json!(answer.text.trim()));
                    Value::Object(out)
                }
            };
            answer["emailId"] = json!(email_id);
            answer["threadId"] = json!(thread_id);
            Ok(answer)
        };
        self.stoppable(stream_id, work).await
    }

    /// A stored message with its body (downloaded once when it's only a preview), ready for a model.
    /// Without `download`, only what is stored (for estimates, which never download).
    async fn stored_mail(&self, message_id: &str, max_chars: usize, download: bool) -> Result<MailText> {
        let id = format!("m:{message_id}");
        let detail =
            if download { self.get_thread(&id, true).await? } else { self.inner.store.get_thread(&id, true)? };
        let message = detail
            .messages
            .into_iter()
            .next()
            .ok_or_else(|| Error::assist("notFound", "This mail no longer exists."))?;
        Ok(MailText::from_stored(&message, max_chars))
    }

    // -------------------------------------------------------- spam check

    /// A second opinion on a mail, with what is known about it and its sender.
    pub async fn assist_spam_check(&self, message_id: &str, language: Option<&str>) -> Result<Value> {
        let message = self
            .inner
            .store
            .messages_by_ids(&[message_id.to_string()])?
            .pop()
            .ok_or_else(|| Error::assist("notFound", "This mail no longer exists."))?;
        let mut answer = match self.assist_target(&message.account_id).await? {
            Target::Server(client) => {
                let (_, remote) = self.remote_id(message_id)?;
                server::spam_check(&client, &remote, language).await?
            }
            Target::Device => self.spam_check_on_device(&message, language).await?,
        };
        answer["emailId"] = json!(message_id);
        Ok(answer)
    }

    async fn spam_check_on_device(&self, message: &Message, language: Option<&str>) -> Result<Value> {
        let location = self
            .inner
            .store
            .locations(std::slice::from_ref(&message.id))?
            .pop()
            .ok_or_else(|| Error::assist("notFound", "This mail no longer exists."))?;
        let raw = self.inner.raw_message(&location).await?;
        let mail = MailText::from_raw(message, &raw, mail::MAX_MAIL_CHARS);
        let signals = self.spam_signals(message, &mail, true).await?;
        let prompt = prompts::spam_check(&mail, &signals::findings(&signals), language);
        let typical = estimate::output_tokens(estimate::Answer::SpamCheck, &prompt);
        let (answer, effective) =
            self.device().ask(self.assist_http()?, Feature::SpamCheck, &prompt, typical, None).await?;
        let (verdict, confidence, reasons) = validate::parse_spam(&answer.text)
            .ok_or_else(|| Error::assist("providerFailed", "The model's answer wasn't a verdict."))?;
        let mut out = local::answer_json(&effective, &answer);
        out.insert("verdict".into(), json!(verdict));
        out.insert("confidence".into(), json!(confidence));
        out.insert("reasons".into(), json!(reasons));
        out.insert("signals".into(), serde_json::to_value(&signals)?);
        Ok(Value::Object(out))
    }

    /// What is known about a mail and its sender. Without `contacts`, the address books aren't
    /// asked (an estimate must not wait for servers).
    async fn spam_signals(&self, message: &Message, mail: &MailText, contacts: bool) -> Result<signals::SpamSignals> {
        let from = message.from.email.trim().to_lowercase();
        let (spam_score, spam_threshold, tests) = signals::spam_status(&mail.headers);
        let in_junk = self
            .inner
            .store
            .message_roles(std::slice::from_ref(&message.id))?
            .first()
            .is_some_and(|(_, _, role)| role.as_deref() == Some("junk"));
        let (earlier, earlier_in_junk, written_to, first) = self.inner.store.sender_history(&from, mail.date)?;
        let in_contacts = contacts && self.address_book().await.iter().any(|(_, email)| *email == from);
        Ok(signals::SpamSignals {
            authentication: signals::authentication(&mail.headers, &from),
            spam_score,
            spam_threshold,
            tests,
            in_junk,
            sender: signals::SenderSignals {
                address: from,
                earlier_messages: earlier,
                earlier_in_junk,
                written_to,
                in_contacts,
                first_seen: first.filter(|_| earlier > 0).map(crate::mime::iso8601),
            },
        })
    }

    /// Names and addresses (lower case) of the address books already known; ones that don't
    /// answer quickly are left out.
    async fn address_book(&self) -> Vec<(String, String)> {
        let Ok(accounts) = self.inner.store.accounts() else { return Vec::new() };
        let reads = accounts.iter().map(|account| async move {
            match self.inner.contacts_source_known(&account.id).await {
                Some(Ok(_)) => tokio::time::timeout(SERVER_WAIT, self.inner.remote_cards(&account.id)).await.ok(),
                _ => None,
            }
        });
        let mut people = Vec::new();
        for cards in futures::future::join_all(reads).await.into_iter().flatten().flatten() {
            for remote in cards.iter().take(5000) {
                let card = Value::Object(remote.card.clone());
                let name = super::contacts_ops::card_name(&card).unwrap_or_default();
                for email in card.get("emails").and_then(Value::as_object).into_iter().flat_map(|e| e.values()) {
                    if let Some(address) = email.get("address").and_then(Value::as_str) {
                        people.push((name.clone(), address.trim().to_lowercase()));
                    }
                }
            }
        }
        people
    }

    // ------------------------------------------------------------ events

    /// Appointments, deadlines and trips in a mail, for "add to calendar".
    pub async fn assist_extract_events(&self, message_id: &str, include_images: bool) -> Result<Value> {
        let message = self
            .inner
            .store
            .messages_by_ids(&[message_id.to_string()])?
            .pop()
            .ok_or_else(|| Error::assist("notFound", "This mail no longer exists."))?;
        match self.assist_target(&message.account_id).await? {
            Target::Server(client) => {
                let (_, remote) = self.remote_id(message_id)?;
                let answer = server::extract_events(&client, &remote, include_images).await?;
                let who = json!({
                    "providerId": answer.get("providerId"),
                    "providerName": answer.get("providerName"),
                    "model": answer.get("model"),
                    "usage": answer.get("usage"),
                });
                Ok(json!({ "events": answer.get("events").cloned().unwrap_or_else(|| json!([])), "answer": who }))
            }
            Target::Device => self.events_on_device(message_id, include_images).await,
        }
    }

    async fn events_on_device(&self, message_id: &str, include_images: bool) -> Result<Value> {
        let mail = self.stored_mail(message_id, mail::MAX_MAIL_CHARS, true).await?;
        // The text read from the mail's own pictures (never the pictures themselves, and never
        // remote ones), bounded like the mail's text; a mail whose pictures can't be read goes
        // without.
        let image_text = if include_images { self.picture_text_for_events(message_id).await } else { Vec::new() };
        let prompt = prompts::extract_events(&mail, &image_text);
        let typical = estimate::output_tokens(estimate::Answer::Events, &prompt);
        let (answer, effective) =
            self.device().ask(self.assist_http()?, Feature::ExtractEvents, &prompt, typical, None).await?;
        let parsed = validate::json_answer(&answer.text)
            .ok_or_else(|| Error::assist("providerFailed", "The model's answer had no dates in the asked form."))?;
        let mut people: Vec<(String, String)> = mail
            .from
            .iter()
            .chain(&mail.to)
            .chain(&mail.cc)
            .map(|a| (a.name.clone().unwrap_or_default(), a.email.trim().to_lowercase()))
            .collect();
        people.extend(self.address_book().await);
        let mut mine: HashSet<String> =
            self.inner.store.accounts()?.into_iter().map(|a| a.email.to_lowercase()).collect();
        mine.extend(self.list_identities()?.into_iter().map(|i| i.email.to_lowercase()));
        let mut source = mail.searchable();
        for text in &image_text {
            source.push('\n');
            source.push_str(text);
        }
        let context = EventContext { source: &source, links: &mail.links, people: &people, mine: &mine };
        let events = validate::parse_events(&parsed, &context);
        Ok(json!({ "events": events, "answer": Value::Object(local::answer_json(&effective, &answer)) }))
    }

    /// The texts in a mail's embedded and attached pictures, at most `IMAGE_TEXT_CHARS` together.
    async fn picture_text_for_events(&self, message_id: &str) -> Vec<String> {
        let Ok(result) = self.image_text(message_id, false).await else { return Vec::new() };
        cap_picture_texts(result.images.into_iter().map(|image| image.text))
    }

    // ---------------------------------------------------------- estimate

    /// What a call would take, for the tooltip on its button: `method` is `Assist/compose`,
    /// `Assist/summarize`, `Assist/spamCheck` or `Assist/extractEvents`, `arguments` what the page
    /// passes to that call (the app's ids). A UwUMail account asks its server (`Assist/estimate`);
    /// `None` when that server is older and doesn't know the method. Everything else is counted
    /// here with the same prompt, never downloading, reading pictures or asking a model.
    pub async fn assist_estimate(
        &self,
        account_id: &str,
        method: &str,
        arguments: Value,
        currency: Option<&str>,
    ) -> Result<Option<Value>> {
        let currency = super::price_ops::currency(currency);
        let method =
            Method::parse(method).ok_or_else(|| Error::assist("invalidArguments", "This can't be estimated."))?;
        let message_id = text_arg(&arguments, "emailId").map(String::from);
        let thread_id = text_arg(&arguments, "threadId").map(String::from);
        // Whose assistant answers: the draft's account, else the mail's, as the call itself does.
        let messages = match method {
            Method::Compose => Vec::new(),
            Method::Summarize if message_id.is_none() => match &thread_id {
                Some(thread) => self.inner.store.get_thread(thread, true)?.messages,
                None => return Err(Error::assist("invalidArguments", "Nothing to summarize.")),
            },
            _ => {
                let id = message_id.clone().ok_or_else(|| Error::assist("invalidArguments", "Which mail?"))?;
                self.inner.store.get_thread(&format!("m:{id}"), true)?.messages
            }
        };
        let account = match messages.last() {
            Some(last) => last.account_id.clone(),
            None if method == Method::Compose => account_id.to_string(),
            None => return Err(Error::assist("notFound", "This mail no longer exists.")),
        };
        match self.assist_target(&account).await? {
            Target::Server(client) => {
                let mut remote = arguments.clone();
                match method {
                    Method::Compose => {
                        if let Some(reply) = text_arg(&arguments, "replyToEmailId") {
                            remote["replyToEmailId"] = match self.remote_id(reply) {
                                Ok((owner, id)) if owner == account => Value::String(id),
                                _ => Value::Null,
                            };
                        }
                    }
                    Method::Summarize if message_id.is_none() => {
                        let last = messages.last().map(|m| m.id.clone()).unwrap_or_default();
                        let (_, email) = self.remote_id(&last)?;
                        let responses = client
                            .call(vec![(
                                "Email/get",
                                json!({ "accountId": client.account_id(), "ids": [email], "properties": ["threadId"] }),
                            )])
                            .await?;
                        remote["threadId"] =
                            responses.get(0, "Email/get")?.pointer("/list/0/threadId").cloned().ok_or_else(|| {
                                Error::assist("notFound", "The server doesn't know this conversation.")
                            })?;
                        remote["emailId"] = Value::Null;
                    }
                    _ => {
                        let (_, email) = self.remote_id(message_id.as_deref().unwrap_or_default())?;
                        remote["emailId"] = Value::String(email);
                        if method == Method::Summarize {
                            remote["threadId"] = Value::Null;
                        }
                    }
                }
                if let Some(object) = remote.as_object_mut() {
                    object.remove("accountId");
                }
                match server::call(
                    &client,
                    "Assist/estimate",
                    json!({ "method": method.as_str(), "arguments": remote, "currency": currency }),
                )
                .await
                {
                    Ok(answer) => Ok(Some(answer)),
                    // A server from before 0.19 has no estimates: no tooltip, no error.
                    Err(error) if matches!(error.assist_kind(), Some("unknownMethod" | "unknownCapability")) => {
                        Ok(None)
                    }
                    Err(error) => Err(error),
                }
            }
            Target::Device => {
                self.estimate_on_device(&account, method, &arguments, &messages, &currency).await.map(Some)
            }
        }
    }

    async fn estimate_on_device(
        &self,
        account_id: &str,
        method: Method,
        arguments: &Value,
        messages: &[Message],
        currency: &str,
    ) -> Result<Value> {
        let device = self.priced_device().await;
        let effective = device
            .effective(method.feature())?
            .ok_or_else(|| Error::assist("assistUnavailable", "No provider set up on this device can do this."))?;
        let language = text_arg(arguments, "language");
        let (prompt, answer) = match method {
            Method::Compose => {
                let (prompt, _) = self.compose_prompt(account_id, arguments, false).await?;
                let output = estimate::output_tokens(compose_answer(arguments), &prompt);
                (prompt, output)
            }
            Method::Summarize => {
                let (prompt, mails) = summarize_prompt(messages, language);
                let output = estimate::output_tokens(estimate::Answer::Summary { mails }, &prompt);
                (prompt, output)
            }
            Method::SpamCheck => {
                let message =
                    messages.last().ok_or_else(|| Error::assist("notFound", "This mail no longer exists."))?;
                let mail = MailText::from_stored(message, mail::MAX_MAIL_CHARS);
                let signals = self.spam_signals(message, &mail, false).await?;
                let prompt = prompts::spam_check(&mail, &signals::findings(&signals), language);
                let output = estimate::output_tokens(estimate::Answer::SpamCheck, &prompt);
                (prompt, output)
            }
            Method::ExtractEvents => {
                let message =
                    messages.last().ok_or_else(|| Error::assist("notFound", "This mail no longer exists."))?;
                let mail = MailText::from_stored(message, mail::MAX_MAIL_CHARS);
                let include_images = arguments.get("includeImages").and_then(Value::as_bool) == Some(true);
                let image_text = if include_images { self.cached_picture_text(message) } else { Vec::new() };
                let prompt = prompts::extract_events(&mail, &image_text);
                let output = estimate::output_tokens(estimate::Answer::Events, &prompt);
                (prompt, output)
            }
        };
        let who = (effective.provider.id.as_str(), effective.provider.name.as_str(), effective.model.as_str());
        let planned = device.estimate(&effective, method.feature(), &prompt, answer)?;
        // This device has no daily limits.
        let mut out = estimate::answer_json(method, &planned, who, (None, None));
        let cost = device
            .price_of(&effective.provider, &effective.model)
            .map(|price| (planned.cost(&price), planned.max_cost(&price)));
        out["cost"] = estimate::cost_json(device.prices.as_deref().unwrap_or(&PriceTable::default()), cost, currency);
        Ok(out)
    }

    /// The text of a mail's pictures as far as it was read already; a guess per picture otherwise.
    fn cached_picture_text(&self, message: &Message) -> Vec<String> {
        let cached = self.inner.image_texts.lock().unwrap().get(&message.id, false);
        let texts: Vec<String> = match cached {
            Some(result) => result.images.into_iter().map(|image| image.text).collect(),
            None => {
                let pictures = message
                    .attachments
                    .iter()
                    .filter(|a| a.mime_type.to_ascii_lowercase().starts_with("image/"))
                    .count();
                estimate::unread_pictures(pictures)
            }
        };
        cap_picture_texts(texts)
    }

    // ------------------------------------------------------ local models

    /// Ollama and LM Studio running on this computer, with their installed models, and whether
    /// this device has a provider at that address already.
    pub async fn assist_local_models(&self) -> Result<Value> {
        let found = discover::local_models(self.assist_http()?, &discover::CANDIDATES).await;
        let providers = self.device().providers()?;
        let list = found
            .into_iter()
            .map(|found| {
                let kind = ProviderKind::parse(found.kind);
                let address = kind.and_then(|kind| provider::check_base_url(kind, found.base_url).ok());
                let added =
                    providers.iter().any(|p| p.kind == found.kind && p.base_url.is_some() && p.base_url == address);
                let mut value = serde_json::to_value(&found).unwrap_or(Value::Null);
                value["added"] = Value::Bool(added);
                value
            })
            .collect();
        Ok(Value::Array(list))
    }

    /// The models at an address that isn't saved yet (Ollama, OpenAI-compatible), for the model
    /// list while a provider is being added on this device. The address passes the same check as
    /// a saved one.
    pub async fn assist_probe_models(&self, input: Value) -> Result<Value> {
        self.device().probe_models(self.assist_http()?, &input).await
    }

    // ---------------------------------------------------------- keywords

    /// Sets (true) or takes off (false) own keywords, e.g. labels by hand. IMAP folders that keep
    /// no own keywords refuse with `not_supported`.
    pub async fn set_keywords(&self, message_ids: &[String], keywords: &HashMap<String, bool>) -> Result<()> {
        let keywords: Vec<(String, bool)> = keywords.iter().map(|(k, on)| (k.trim().to_lowercase(), *on)).collect();
        if keywords.is_empty() {
            return Ok(());
        }
        if let Some((bad, _)) = keywords.iter().find(|(k, _)| !validate::is_own_keyword(k)) {
            return Err(Error::invalid(format!("\"{bad}\" can't be a label.")));
        }
        let locations = self.inner.store.locations(message_ids)?;
        for (account_id, remote_ids) in group_remote(&locations) {
            let client = self.inner.jmap_client(&account_id).await?;
            let pairs: Vec<(&str, bool)> = keywords.iter().map(|(k, on)| (k.as_str(), *on)).collect();
            jmap_sync::set_keywords(&client, &remote_ids, &pairs).await?;
        }
        for ((account_id, path), uids) in group_by_folder(&locations) {
            for (keyword, on) in &keywords {
                with_session!(self.inner, &account_id, |session| imap::store_keyword(
                    session, &path, &uids, keyword, *on
                ))?;
            }
        }
        for (keyword, on) in &keywords {
            self.inner.store.change_keyword(message_ids, keyword, *on)?;
        }
        self.inner.emit_changed(&locations);
        Ok(())
    }

    // ------------------------------------------------------------ labels

    /// Asks this device's provider which of the person's labels fit a mail, sets them and logs
    /// each with the reason. Returns the label ids set.
    async fn label_on_device(&self, message_id: &str) -> Result<Vec<String>> {
        let labels: Vec<Label> = self.device().labels()?;
        if labels.is_empty() {
            return Ok(Vec::new());
        }
        let message = self
            .inner
            .store
            .messages_by_ids(&[message_id.to_string()])?
            .pop()
            .ok_or_else(|| Error::assist("notFound", "This mail no longer exists."))?;
        let mail = MailText::from_stored(&message, mail::LABEL_MAIL_CHARS);
        let list: Vec<(String, String)> = labels.iter().map(|l| (l.name.clone(), l.description.clone())).collect();
        let prompt = prompts::labels(&mail, &list);
        let typical = estimate::output_tokens(estimate::Answer::Labels, &prompt);
        let (answer, effective) =
            self.device().ask(self.assist_http()?, Feature::AutoLabels, &prompt, typical, None).await?;
        let Some(parsed) = validate::json_answer(&answer.text) else {
            return Err(Error::assist("providerFailed", "The model's answer had no labels in the asked form."));
        };
        let picks: Vec<_> = validate::parse_labels(&parsed, &labels)
            .into_iter()
            .filter(|pick| !message.keywords.contains(&pick.label.keyword))
            .collect();
        if picks.is_empty() {
            return Ok(Vec::new());
        }
        let wanted: HashMap<String, bool> = picks.iter().map(|p| (p.label.keyword.clone(), true)).collect();
        self.set_keywords(std::slice::from_ref(&message.id), &wanted).await?;
        let _ = self.inner.store.forget_label_log_before(now_secs() - LOG_DAYS * 86_400);
        let mut set = Vec::new();
        for pick in picks {
            self.inner.store.insert_label_log(&LabelLogRecord {
                id: format!("l{}", uuid::Uuid::new_v4().simple()),
                account_id: message.account_id.clone(),
                message_id: message.id.clone(),
                label_id: pick.label.id.clone(),
                name: pick.label.name.clone(),
                keyword: pick.label.keyword.clone(),
                reason: pick.reason,
                provider_name: Some(effective.provider.name.clone()),
                model: Some(effective.model.clone()),
                created_at: now_secs(),
                undone: false,
            })?;
            set.push(pick.label.id);
        }
        Ok(set)
    }

    /// Whether auto-labels run on this device now: switched on, labels there, a provider for them.
    fn auto_labels_ready(&self) -> Result<Option<Effective>> {
        let device = self.device();
        if !device.auto_labels_on()? || device.labels()?.is_empty() {
            return Ok(None);
        }
        device.effective(Feature::AutoLabels)
    }

    /// Labels new inbox mail of one mailbox, within the day's limit.
    async fn auto_label(&self, account_id: &str, message_ids: Vec<String>) {
        match self.auto_labels_ready() {
            Ok(Some(_)) => {}
            _ => return,
        }
        let Ok(Target::Device) = self.assist_target(account_id).await else { return };
        let Ok(account) = self.inner.store.account(account_id) else { return };
        let Ok(roles) = self.inner.store.message_roles(&message_ids) else { return };
        let mut labelled = false;
        for (id, _, role) in
            roles.into_iter().filter(|(_, _, role)| role.as_deref() == Some("inbox")).take(LABELS_AT_ONCE)
        {
            if self.device().requests_today(Feature::AutoLabels).unwrap_or(u64::MAX) >= local::AUTO_LABELS_PER_DAY {
                tracing::debug!("Auto-labels reached today's limit");
                break;
            }
            let _ = role;
            let from_self = self
                .inner
                .store
                .messages_by_ids(std::slice::from_ref(&id))
                .ok()
                .and_then(|mut m| m.pop())
                .is_some_and(|m| m.from.email.eq_ignore_ascii_case(&account.email));
            if from_self {
                continue;
            }
            match self.label_on_device(&id).await {
                Ok(set) => labelled |= !set.is_empty(),
                // The server keeps no own keywords: nothing more to do for this mailbox now.
                Err(error) if error.code == ErrorCode::NotSupported => break,
                Err(error) => {
                    tracing::debug!("Auto-labels skipped a mail: {error}");
                    if error.assist_kind() != Some("providerFailed") {
                        break;
                    }
                }
            }
        }
        if labelled {
            self.assist_changed(Some(account_id));
        }
    }
}

/// The prompt of a summary of these messages (the latest ones of a conversation), and how many
/// mails it reads.
/// The answer a compose request expects: a new mail, or the draft changed.
fn compose_answer(request: &Value) -> estimate::Answer<'_> {
    match text_arg(request, "mode").unwrap_or("write") {
        "write" => estimate::Answer::Write,
        _ => estimate::Answer::Rewrite { text: request.get("text").and_then(Value::as_str).unwrap_or("") },
    }
}

fn summarize_prompt(messages: &[Message], language: Option<&str>) -> (Prompt, usize) {
    let start = messages.len().saturating_sub(MAX_THREAD_MAILS);
    let mails: Vec<MailText> =
        messages[start..].iter().map(|m| MailText::from_stored(m, mail::MAX_MAIL_CHARS)).collect();
    (prompts::summarize(&mails, language), mails.len())
}

/// Picture texts for a prompt: at most `IMAGE_TEXT_CHARS` together, empty ones left out.
fn cap_picture_texts(texts: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut left = IMAGE_TEXT_CHARS;
    let mut out = Vec::new();
    for text in texts {
        let text = text.trim();
        if text.is_empty() || left == 0 {
            continue;
        }
        let part: String = text.chars().take(left).collect();
        left -= part.chars().count();
        out.push(part);
    }
    out
}

/// A device label log entry in the server's shape.
fn log_json(entry: &LabelLogRecord) -> Value {
    json!({
        "id": entry.id,
        "emailId": entry.message_id,
        "labelId": entry.label_id,
        "name": entry.name,
        "keyword": entry.keyword,
        "reason": entry.reason,
        "providerName": entry.provider_name,
        "model": entry.model,
        "createdAt": crate::mime::iso8601(entry.created_at),
        "undone": entry.undone,
    })
}

impl Inner {
    /// Hands new inbox mail to auto-labels (they run apart from the sync, and only for mailboxes
    /// without a server assistant with the person's switch on).
    pub(super) fn queue_auto_labels(&self, account_id: &str, message_ids: &[String]) {
        if message_ids.is_empty() {
            return;
        }
        let ids: Vec<String> = message_ids.iter().take(LABELS_AT_ONCE).cloned().collect();
        let _ = self.assist.queue.send((account_id.to_string(), ids));
    }
}

/// Labels queued mail one mailbox at a time, while the engine runs.
pub(super) fn start_auto_labels(engine: Engine) {
    let Some(mut queue) = engine.inner.assist.queue_rx.lock().unwrap().take() else { return };
    let runtime = engine.inner.runtime.clone();
    runtime.spawn(async move {
        while let Some((account_id, message_ids)) = queue.recv().await {
            engine.auto_label(&account_id, message_ids).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_subject_comes_first_while_streaming() {
        let got = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&got);
        let sink: StreamSink = Arc::new(move |event| seen.lock().unwrap().push(event));
        let mut relay = Relay::new(Arc::clone(&sink), true);
        for piece in ["SUBJ", "ECT: Frei", "tag\n", "\nHallo", " Mia"] {
            relay.push(piece);
        }
        relay.flush();
        assert_eq!(
            *got.lock().unwrap(),
            [
                StreamEvent::Subject { subject: "Freitag".into() },
                StreamEvent::Delta { text: "Hallo".into() },
                StreamEvent::Delta { text: " Mia".into() }
            ]
        );
        got.lock().unwrap().clear();
        let mut relay = Relay::new(sink, true);
        for piece in ["Hä", "llo"] {
            relay.push(piece);
        }
        relay.flush();
        assert_eq!(
            *got.lock().unwrap(),
            [StreamEvent::Delta { text: "Hä".into() }, StreamEvent::Delta { text: "llo".into() }]
        );
    }

    /// An engine with one IMAP mailbox and one mail in its inbox; the mail's id.
    fn engine_with_mail() -> (tempfile::TempDir, Engine, String) {
        use crate::model::{AccountColor, AuthKind, FolderRole, MessageFlags, Security, ServerSettings};
        use crate::store::{AccountRecord, FolderInfo};
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::new(EngineOptions {
            data_dir: dir.path().to_path_buf(),
            secrets: Arc::new(crate::secrets::MemorySecrets::default()),
            open_url: Arc::new(|_| {}),
            recognizer: None,
        })
        .unwrap();
        let store = &engine.inner.store;
        store
            .insert_account(&AccountRecord {
                id: "acc".into(),
                name: "Test".into(),
                email: "mini@example.org".into(),
                display_name: "Mini".into(),
                color: AccountColor::Pink,
                auth: AuthKind::Password,
                username: "mini@example.org".into(),
                imap: ServerSettings { host: "imap.example.org".into(), port: 993, security: Security::Tls },
                smtp: ServerSettings { host: "smtp.example.org".into(), port: 465, security: Security::Tls },
                protocol: Protocol::Imap,
                jmap_url: None,
            })
            .unwrap();
        let inbox = store
            .upsert_folder(
                "acc",
                &FolderInfo {
                    path: "INBOX",
                    name: "INBOX",
                    role: Some(FolderRole::Inbox),
                    delimiter: Some("/"),
                    selectable: true,
                    parent_ref: None,
                },
            )
            .unwrap();
        let raw = "From: Mia <mia@example.com>\r\nTo: mini@example.org\r\nSubject: Sommerfest\r\n\
Date: Tue, 1 Sep 2026 09:00:00 +0200\r\nMessage-ID: <fest@example.com>\r\n\
Content-Type: text/plain; charset=utf-8\r\n\r\nWir feiern am 12. September um 18 Uhr im Park. Kommst du?\r\n";
        let parsed = crate::mime::parse(raw.as_bytes());
        let id = store
            .insert_message("acc", &inbox, 1, MessageFlags::default(), raw.len() as u64, None, &parsed)
            .unwrap()
            .unwrap();
        (dir, engine, id)
    }

    #[tokio::test]
    async fn estimates_on_this_device_count_the_real_prompt_and_ask_nobody() {
        let (_dir, engine, id) = engine_with_mail();
        let unavailable =
            engine.assist_estimate("acc", "Assist/summarize", json!({ "emailId": id }), None).await.unwrap_err();
        assert_eq!(unavailable.assist_kind(), Some("assistUnavailable"));
        // A provider nobody listens to: an estimate never reaches it.
        engine
            .device()
            .create_provider(
                &json!({ "kind": "ollama", "name": "Ollama", "baseUrl": "http://127.0.0.1:9", "model": "llama3" }),
            )
            .unwrap();

        let summary =
            engine.assist_estimate("acc", "Assist/summarize", json!({ "emailId": id }), None).await.unwrap().unwrap();
        let messages = engine.inner.store.get_thread(&format!("m:{id}"), true).unwrap().messages;
        let (prompt, _) = summarize_prompt(&messages, None);
        let input = estimate::prompt_tokens(&prompt) + estimate::framing_tokens(ProviderKind::Ollama, &prompt);
        assert_eq!(summary["inputTokens"], input, "the prompt and what the API adds around it");
        assert_eq!(summary["outputTokens"], estimate::TYPICAL_SUMMARY_TOKENS);
        assert_eq!(summary["reasoningTokens"], 0, "llama3 doesn't think");
        assert_eq!(summary["totalTokens"], input + estimate::TYPICAL_SUMMARY_TOKENS);
        assert_eq!(summary["calls"].as_array().unwrap().len(), 1, "one call on this device");
        assert_eq!(summary["calls"][0]["purpose"], "main");
        assert_eq!((summary["imageCount"].as_u64(), summary["calibrated"].as_bool()), (Some(0), Some(false)));
        assert_eq!(summary["cost"]["amount"], 0.0, "Ollama is free");
        assert_eq!(summary["cost"]["max"]["amount"], 0.0);
        assert_eq!(summary["providerName"], "Ollama");
        assert_eq!(summary["model"], "llama3");
        assert!(summary["tokensLeftToday"].is_null() && summary["requestsLeftToday"].is_null());

        let thread = messages[0].thread_id.clone();
        let whole = engine
            .assist_estimate("acc", "Assist/summarize", json!({ "threadId": thread }), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(whole["inputTokens"], summary["inputTokens"], "a conversation of one mail");

        let spam =
            engine.assist_estimate("acc", "Assist/spamCheck", json!({ "emailId": id }), None).await.unwrap().unwrap();
        assert_eq!(spam["outputTokens"], estimate::TYPICAL_SPAM_TOKENS);
        assert!(spam["inputTokens"].as_u64().unwrap() > 50);

        let events = engine
            .assist_estimate("acc", "Assist/extractEvents", json!({ "emailId": id, "includeImages": true }), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(events["outputTokens"], estimate::TYPICAL_EVENTS_TOKENS);
        assert!(events["inputTokens"].as_u64().unwrap() > spam["inputTokens"].as_u64().unwrap() / 2);

        let write = engine
            .assist_estimate("acc", "Assist/compose", json!({ "mode": "write", "instruction": "Sag zu" }), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(write["outputTokens"], estimate::TYPICAL_WRITE_TOKENS);
        let long = "Liebe Mia, danke für die Einladung. ".repeat(40);
        let rewrite = engine
            .assist_estimate(
                "acc",
                "Assist/compose",
                json!({ "mode": "rewrite", "preset": "shorter", "text": long }),
                None,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(rewrite["outputTokens"], estimate::tokens([long.as_str()]));
        assert!(rewrite["inputTokens"].as_u64().unwrap() > rewrite["outputTokens"].as_u64().unwrap());
        // The same checks as the real call.
        let empty =
            engine.assist_estimate("acc", "Assist/compose", json!({ "mode": "write" }), None).await.unwrap_err();
        assert_eq!(empty.assist_kind(), Some("invalidArguments"));
        let unknown = engine.assist_estimate("acc", "AssistLabel/apply", json!({}), None).await.unwrap_err();
        assert_eq!(unknown.assist_kind(), Some("invalidArguments"));

        // Nothing was asked, so nothing was counted.
        for feature in Feature::ALL {
            assert_eq!(engine.device().requests_today(feature).unwrap(), 0);
        }
    }

    #[tokio::test]
    async fn costs_follow_the_fetched_prices_and_a_price_set_by_hand() {
        use crate::assist::prices::{Sources, tests as fixtures};
        use crate::assist::provider::{ChatAnswer, TokenUsage};
        let (_dir, engine, id) = engine_with_mail();
        let base = fixtures::serve(vec![("/litellm", 200, fixtures::LITELLM), ("/ecb", 200, fixtures::ECB)]).await;
        engine.use_price_sources(Sources {
            litellm: format!("{base}/litellm"),
            openrouter: format!("{base}/openrouter"),
            ecb: format!("{base}/ecb"),
        });
        let created = engine
            .assist_create_provider(
                DEVICE_SCOPE,
                json!({ "kind": "openai", "name": "OpenAI", "apiKey": "sk-test-1", "model": "gpt-5-mini" }), // gitleaks:allow
            )
            .await
            .unwrap();
        let provider_id = created["id"].as_str().unwrap().to_string();
        let providers = engine.assist_providers(DEVICE_SCOPE).await.unwrap();
        assert_eq!(providers[0]["price"]["source"], "auto", "fetched on first need: {providers}");
        assert_eq!(providers[0]["price"]["inputPerMillion"], 0.25);
        assert!(providers[0]["inputPricePerMillion"].is_null());
        assert!(engine.inner.store.assist_setting("prices").unwrap().is_some(), "kept for offline");

        let spam =
            engine.assist_estimate("acc", "Assist/spamCheck", json!({ "emailId": id }), None).await.unwrap().unwrap();
        let (input, output) = (spam["inputTokens"].as_f64().unwrap(), spam["outputTokens"].as_f64().unwrap());
        let reasoning = spam["reasoningTokens"].as_f64().unwrap();
        assert!(reasoning > 0.0, "gpt-5-mini thinks before it answers");
        let usd = (input * 0.25 + (output + reasoning) * 2.0) / 1e6;
        let parts = &spam["cost"]["parts"];
        assert!((parts["reasoning"].as_f64().unwrap() - reasoning * 2.0 / 1e6 / 1.17).abs() < 1e-12);
        let max = spam["cost"]["max"]["usd"].as_f64().unwrap();
        assert!((max - (input * 0.25 + 4000.0 * 2.0) / 1e6).abs() < 1e-12, "every token it may write: {max}");
        assert_eq!(spam["cost"]["currency"], "EUR");
        assert!((spam["cost"]["usd"].as_f64().unwrap() - usd).abs() < 1e-12);
        assert!((spam["cost"]["amount"].as_f64().unwrap() - usd / 1.17).abs() < 1e-12);
        let dollars = engine
            .assist_estimate("acc", "Assist/spamCheck", json!({ "emailId": id }), Some("usd"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(dollars["cost"]["currency"], "USD");
        assert!((dollars["cost"]["amount"].as_f64().unwrap() - usd).abs() < 1e-12);

        // A price set by hand wins; nonsense is refused.
        engine
            .assist_update_provider(
                DEVICE_SCOPE,
                &provider_id,
                json!({ "inputPricePerMillion": 1, "outputPricePerMillion": 4 }),
            )
            .await
            .unwrap();
        let bad =
            engine.assist_update_provider(DEVICE_SCOPE, &provider_id, json!({ "inputPricePerMillion": -1 })).await;
        assert_eq!(bad.unwrap_err().assist_kind(), Some("invalidProperties"));
        let manual = engine.assist_providers(DEVICE_SCOPE).await.unwrap();
        assert_eq!(manual[0]["price"]["source"], "manual");
        assert_eq!(manual[0]["outputPricePerMillion"], 4.0);

        // Usage keeps what each request cost then; a request without token counts has no cost.
        let device = engine.device();
        let effective = device.effective(Feature::SpamCheck).unwrap().unwrap();
        let usage = TokenUsage { input_tokens: 1_000_000, output_tokens: 0, ..TokenUsage::default() };
        let answer = ChatAnswer { text: "ok".into(), usage: Some(usage), calls: 1 };
        device.record_usage(&effective, Feature::SpamCheck, Some(&answer), None).unwrap();
        let silent = ChatAnswer { text: "ok".into(), usage: None, calls: 1 };
        device.record_usage(&effective, Feature::SpamCheck, Some(&silent), None).unwrap();
        device.record_usage(&effective, Feature::Summarize, Some(&silent), None).unwrap();
        let usage = engine.assist_usage(DEVICE_SCOPE, Some(7), Some("USD")).await.unwrap();
        let row =
            |feature: &str| usage["days"].as_array().unwrap().iter().find(|r| r["feature"] == feature).unwrap().clone();
        assert_eq!(row("spamCheck")["cost"]["amount"], 1.0);
        assert!(row("summarize")["cost"].is_null());
        assert_eq!(usage["today"][0]["cost"]["amount"], 1.0);
        let euros = engine.assist_usage(DEVICE_SCOPE, Some(7), None).await.unwrap();
        assert_eq!(euros["today"][0]["cost"]["currency"], "EUR");
    }

    #[tokio::test]
    async fn estimates_learn_from_the_last_real_calls() {
        use crate::assist::provider::{ChatAnswer, TokenUsage};
        let (_dir, engine, id) = engine_with_mail();
        engine
            .device()
            .create_provider(
                &json!({ "kind": "ollama", "name": "Ollama", "baseUrl": "http://127.0.0.1:9", "model": "qwen3" }),
            )
            .unwrap();
        let ask = || engine.assist_estimate("acc", "Assist/spamCheck", json!({ "emailId": id }), None);
        let before = ask().await.unwrap().unwrap();
        assert_eq!(before["calibrated"], false);
        assert!(before["reasoningTokens"].as_u64().unwrap() > 0, "qwen3 thinks");

        // Real calls read twice as much as expected, answered half as long and thought 90 tokens.
        let device = engine.device();
        let effective = device.effective(Feature::SpamCheck).unwrap().unwrap();
        let expected = crate::assist::estimate::Call {
            purpose: "main",
            input: 1000,
            output: 200,
            reasoning: 400,
            images: 0,
            weight: 1.0,
            max_output: 4000,
        };
        let usage =
            TokenUsage { input_tokens: 2000, output_tokens: 100, reasoning_tokens: 90, ..TokenUsage::default() };
        let answer = ChatAnswer { text: "{}".into(), usage: Some(usage), calls: 1 };
        for n in 0..estimate::MIN_CALIBRATION_SAMPLES {
            if n + 1 == estimate::MIN_CALIBRATION_SAMPLES {
                assert_eq!(ask().await.unwrap().unwrap()["calibrated"], false, "four aren't enough");
            }
            device.record_usage(&effective, Feature::SpamCheck, Some(&answer), Some(&expected)).unwrap();
        }
        // A fresh estimate (the page caches them for a minute; the engine doesn't).
        let after = ask().await.unwrap().unwrap();
        assert_eq!(after["calibrated"], true);
        let heuristic = before["inputTokens"].as_u64().unwrap();
        assert_eq!(after["inputTokens"], heuristic * 2);
        assert_eq!(after["outputTokens"], estimate::TYPICAL_SPAM_TOKENS / 2);
        assert_eq!(after["reasoningTokens"], 90);
        // Other features and models learn apart.
        let summary =
            engine.assist_estimate("acc", "Assist/summarize", json!({ "emailId": id }), None).await.unwrap().unwrap();
        assert_eq!(summary["calibrated"], false);
        // The usage view counts the thinking too.
        let usage = engine.assist_usage(DEVICE_SCOPE, Some(1), None).await.unwrap();
        assert_eq!(usage["days"][0]["reasoningTokens"], 450);
        assert_eq!(usage["today"][0]["tokens"], 5 * (2000 + 100 + 90));
    }

    #[tokio::test]
    async fn local_models_cost_nothing_even_offline() {
        let (_dir, engine, id) = engine_with_mail();
        engine
            .assist_create_provider(
                DEVICE_SCOPE,
                json!({ "kind": "openaiCompatible", "name": "LM Studio", "baseUrl": "http://127.0.0.1:1234/v1", "model": "gemma" }),
            )
            .await
            .unwrap();
        let providers = engine.assist_providers(DEVICE_SCOPE).await.unwrap();
        assert_eq!(providers[0]["price"]["source"], "free");
        let spam =
            engine.assist_estimate("acc", "Assist/spamCheck", json!({ "emailId": id }), None).await.unwrap().unwrap();
        assert_eq!(spam["cost"]["amount"], 0.0, "free without any rates");
        assert_eq!(spam["cost"]["currency"], "EUR");
    }

    #[tokio::test]
    async fn models_at_an_unsaved_address_pass_the_same_check() {
        let (_dir, engine, _) = engine_with_mail();
        let refused = engine
            .assist_probe_models(json!({ "kind": "ollama", "baseUrl": "http://169.254.169.254" }))
            .await
            .unwrap_err();
        assert_eq!(refused.assist_kind(), Some("invalidProperties"));
        let refused =
            engine.assist_probe_models(json!({ "kind": "openai", "baseUrl": "https://api.example.com/v1" })).await;
        assert_eq!(refused.unwrap_err().assist_kind(), Some("invalidProperties"), "only own addresses");
        let plain = engine
            .assist_probe_models(json!({ "kind": "openaiCompatible", "baseUrl": "http://llm.example.com/v1" }))
            .await;
        assert_eq!(plain.unwrap_err().assist_kind(), Some("invalidProperties"), "plain http only nearby");
    }

    #[test]
    fn device_log_entries_look_like_the_servers() {
        let entry = LabelLogRecord {
            id: "l1".into(),
            account_id: "a".into(),
            message_id: "m1".into(),
            label_id: "g1".into(),
            name: "Reisen".into(),
            keyword: "reisen".into(),
            reason: "Eine Buchung".into(),
            provider_name: Some("Ollama".into()),
            model: Some("llama3".into()),
            created_at: 0,
            undone: false,
        };
        let value = log_json(&entry);
        assert_eq!(value["emailId"], "m1");
        assert_eq!(value["createdAt"], "1970-01-01T00:00:00Z");
    }
}
