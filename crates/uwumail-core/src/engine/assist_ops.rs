//! The AI assistant for every mailbox (see `crate::assist`): a UwUMail account whose session has
//! `urn:uwumail:jmap:assist` asks its server, every other mailbox the providers set up on this
//! device. The page talks to one shape either way: the server's JMAP shapes, with the app's own
//! message, thread and account ids.

use std::sync::OnceLock;

use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use super::*;
use crate::assist::estimate::{self, Method};
use crate::assist::local::{self, Device};
use crate::assist::mail::{self, MailText};
use crate::assist::prices::PriceTable;
use crate::assist::prompts::{self, ComposeRequest, Prompt, SUBJECT_MARK};
use crate::assist::provider::{self, ProviderKind};
use crate::assist::validate::{self, EventContext};
use crate::assist::{Feature, Label, StreamEvent, StreamSink, discover, foreign, server, signals};
use crate::store::{LabelExample, LabelLogRecord};

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
/// Label log entries are kept this long, and at most this many.
const LOG_DAYS: i64 = 400;
const LOG_KEPT: usize = 20_000;
/// A deleted label comes off at most this many mails, this many at a time, each batch given this
/// long and all of them together about as long as the last.
const UNLABEL_AT_MOST: usize = 20_000;
const UNLABEL_BATCH: usize = 200;
const UNLABEL_BATCH_WAIT: Duration = Duration::from_secs(60);
const UNLABEL_WAIT: Duration = Duration::from_secs(300);

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
    /// Its own UwUMail server's assistant.
    Server(Arc<JmapClient>),
    /// A mailbox of this device whose AI a UwUMail server does (`serverAssist`): the mail's
    /// content goes to that server; labels, settings and learning stay here.
    Foreign(Arc<JmapClient>),
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

    /// Who does the AI of a mailbox: its server, the server this device lends its other mailboxes
    /// to, or this device's providers.
    async fn ai_target(&self, account_id: &str) -> Result<Target> {
        match self.assist_target(account_id).await? {
            Target::Device => Ok(match self.foreign_server().await? {
                Some(client) => Target::Foreign(client),
                None => Target::Device,
            }),
            target => Ok(target),
        }
    }

    /// The UwUMail server that does the AI of this device's mailboxes: the person's choice
    /// (`serverAssist`) while that server allows foreign mail; `None` while it is unset. A chosen
    /// server that can't be asked now, or no longer allows foreign mail, is `assistUnavailable`:
    /// the mail then goes nowhere, neither to another server nor to this device's providers.
    async fn foreign_server(&self) -> Result<Option<Arc<JmapClient>>> {
        let Some(account_id) = self.device().server_assist()? else { return Ok(None) };
        match tokio::time::timeout(SERVER_WAIT, self.assist_target(&account_id)).await {
            Ok(Ok(Target::Server(client))) if server::foreign_mail(&client) => Ok(Some(client)),
            _ => Err(Error::assist(
                "assistUnavailable",
                "The UwUMail server chosen for the AI of your other mailboxes can't do it now.",
            )),
        }
    }

    async fn scope_target(&self, scope: &str) -> Result<Target> {
        if scope == DEVICE_SCOPE {
            return Ok(Target::Device);
        }
        match self.assist_target(scope).await? {
            Target::Server(client) => Ok(Target::Server(client)),
            _ => Err(Error::assist("assistUnavailable", "This mailbox's server has no assistant.")),
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
                Ok(Ok(_)) => device.push(account.id.clone()),
                // A UwUMail server that can't be reached is not handed to this device's providers.
                _ if account.protocol == Protocol::Jmap => {}
                _ => device.push(account.id.clone()),
            }
        }
        Ok((servers, device))
    }

    /// Where the assistant's settings live: one scope per UwUMail account with the assistant, and
    /// this device for every other mailbox. The device's features are those of the server that
    /// does its AI when the person chose one (`serverAssist`).
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
            // A chosen server that can't do it now offers nothing, rather than this device's providers.
            let features = match self.foreign_server().await {
                Ok(Some(client)) => server::features(&client),
                Ok(None) => self.device().features()?,
                Err(_) => None,
            };
            let features = features.unwrap_or_else(|| {
                Value::Object(Feature::ALL.iter().map(|f| (f.as_str().to_string(), Value::Bool(false))).collect())
            });
            let foreign_servers: Vec<String> =
                servers.iter().filter(|(_, client)| server::foreign_mail(client)).map(|(id, _)| id.clone()).collect();
            scopes.push(json!({ "id": DEVICE_SCOPE, "kind": "device", "accountId": null, "accountIds": device,
                                "options": local::options(&features, &foreign_servers) }));
        }
        Ok(Value::Array(scopes))
    }

    /// Per feature whether the assistant can do it now for this mailbox; `None` without one.
    pub async fn assist_features(&self, account_id: &str) -> Result<Option<Value>> {
        match self.ai_target(account_id).await {
            Ok(Target::Server(client) | Target::Foreign(client)) => Ok(server::features(&client)),
            Ok(Target::Device) => self.device().features(),
            // A server that can't be reached right now, or the chosen one that can't do it now:
            // nothing to offer.
            Err(error)
                if error.code == ErrorCode::ConnectionFailed || error.assist_kind() == Some("assistUnavailable") =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    // -------------------------------------------------------- providers

    pub async fn assist_providers(&self, scope: &str) -> Result<Value> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::providers(&client).await,
            _ => self.priced_device().await.providers_json(),
        }
    }

    pub async fn assist_create_provider(&self, scope: &str, input: Value) -> Result<Value> {
        let created = match self.scope_target(scope).await? {
            Target::Server(client) => server::create_provider(&client, input).await?,
            _ => self.device().create_provider(&input)?,
        };
        self.assist_changed(None);
        Ok(created)
    }

    pub async fn assist_update_provider(&self, scope: &str, provider_id: &str, patch: Value) -> Result<()> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::update_provider(&client, provider_id, patch).await?,
            _ => self.device().update_provider(provider_id, &patch)?,
        }
        self.assist_changed(None);
        Ok(())
    }

    pub async fn assist_delete_provider(&self, scope: &str, provider_id: &str) -> Result<()> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::delete_provider(&client, provider_id).await?,
            _ => self.device().delete_provider(provider_id)?,
        }
        self.assist_changed(None);
        Ok(())
    }

    pub async fn assist_models(&self, scope: &str, provider_id: &str) -> Result<Value> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::models(&client, provider_id).await,
            _ => self.device().models(self.assist_http()?, provider_id).await,
        }
    }

    pub async fn assist_chatgpt_login(&self, scope: &str, provider_id: &str) -> Result<Value> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::chatgpt_login(&client, provider_id).await,
            _ => Err(Error::not_supported("ChatGPT sign-in isn't offered on this device.")),
        }
    }

    pub async fn assist_chatgpt_poll(&self, scope: &str, provider_id: &str) -> Result<Value> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::chatgpt_poll(&client, provider_id).await,
            _ => Err(Error::not_supported("ChatGPT sign-in isn't offered on this device.")),
        }
    }

    // --------------------------------------------------------- settings

    pub async fn assist_settings(&self, scope: &str) -> Result<Value> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::settings(&client).await,
            _ => self.device().settings_json(),
        }
    }

    pub async fn assist_update_settings(&self, scope: &str, patch: Value) -> Result<()> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::update_settings(&client, patch).await?,
            _ => {
                if let Some(account_id) = patch.get("serverAssist").and_then(Value::as_str) {
                    self.check_server_assist(account_id.trim()).await?;
                }
                self.device().update_settings(&patch)?
            }
        }
        self.assist_changed(None);
        Ok(())
    }

    /// Whether a UwUMail account's server may do the AI of this device's mailboxes: a JMAP
    /// mailbox of this app whose server has the assistant and allows foreign mail.
    async fn check_server_assist(&self, account_id: &str) -> Result<()> {
        let refused =
            |why: &str| Error::assist("invalidProperties", why).with_properties(vec!["serverAssist".to_string()]);
        let account = self.inner.store.account(account_id).map_err(|_| refused("This mailbox doesn't exist."))?;
        if account.protocol != Protocol::Jmap {
            return Err(refused("Only a UwUMail mailbox's server can do this."));
        }
        match tokio::time::timeout(SERVER_WAIT, self.assist_target(account_id)).await {
            Ok(Ok(Target::Server(client))) if server::foreign_mail(&client) => Ok(()),
            Ok(Ok(Target::Server(_))) => Err(refused("This server doesn't do the AI of other mailboxes.")),
            _ => Err(refused("This mailbox's server has no assistant that can be reached now.")),
        }
    }

    /// Usage per day, provider and feature; costs in `currency` (EUR when not given).
    pub async fn assist_usage(&self, scope: &str, days: Option<u32>, currency: Option<&str>) -> Result<Value> {
        let days = days.unwrap_or(30).clamp(1, 90);
        let currency = super::price_ops::currency(currency);
        match self.scope_target(scope).await? {
            Target::Server(client) => server::usage(&client, days, &currency).await,
            _ => self.priced_device().await.usage_json(days, &currency),
        }
    }

    // ----------------------------------------------------------- labels

    pub async fn assist_labels(&self, scope: &str) -> Result<Value> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::labels(&client).await,
            _ => self.device_labels_json().await,
        }
    }

    /// This device's labels in the server's `AssistLabel` shape, with their counts over the
    /// mailboxes it serves and the examples their classifiers learned.
    async fn device_labels_json(&self) -> Result<Value> {
        let labels = self.device().labels()?;
        if labels.is_empty() {
            return Ok(json!([]));
        }
        let accounts = self.assist_split().await?.1;
        let refs: Vec<LabelRef> = labels
            .iter()
            .map(|label| LabelRef { keyword: label.keyword.clone(), account_ids: accounts.clone() })
            .collect();
        let counts = self.inner.store.label_counts(&refs)?;
        let examples = self.inner.store.label_example_counts()?;
        let list = labels
            .iter()
            .zip(counts)
            .map(|(label, count)| {
                label_json(label, count.total, count.unread, examples.get(&label.id).copied().unwrap_or(0))
            })
            .collect();
        Ok(Value::Array(list))
    }

    pub async fn assist_create_label(&self, scope: &str, input: Value) -> Result<Value> {
        let created = match self.scope_target(scope).await? {
            Target::Server(client) => server::create_label(&client, input).await?,
            _ => label_json(&self.device().create_label(&input)?, 0, 0, 0),
        };
        self.assist_changed(None);
        Ok(created)
    }

    pub async fn assist_update_label(&self, scope: &str, label_id: &str, patch: Value) -> Result<()> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::update_label(&client, label_id, patch).await?,
            _ => self.device().update_label(label_id, &patch)?,
        }
        self.assist_changed(None);
        Ok(())
    }

    /// Deletes a label. On this device its keyword comes off every mail of the mailboxes this
    /// device serves that carries it (as far as the servers take that, in batches, at most
    /// [`UNLABEL_AT_MOST`] mails), and its log, learned senders and examples go. That teaches
    /// nothing.
    pub async fn assist_delete_label(&self, scope: &str, label_id: &str) -> Result<()> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::delete_label(&client, label_id).await?,
            _ => {
                let label = self
                    .device()
                    .labels()?
                    .into_iter()
                    .find(|l| l.id == label_id)
                    .ok_or_else(|| Error::assist("notFound", "This label no longer exists."))?;
                // Only mailboxes whose labels are this device's: a UwUMail account's label of the
                // same keyword is another label.
                let accounts = self.assist_split().await?.1;
                let labelled = self.inner.store.messages_with_keyword(&label.keyword, &accounts, UNLABEL_AT_MOST)?;
                let off: HashMap<String, bool> = [(label.keyword.clone(), false)].into();
                let started = std::time::Instant::now();
                for batch in labelled.chunks(UNLABEL_BATCH) {
                    if started.elapsed() > UNLABEL_WAIT {
                        tracing::debug!("A deleted label stays on some mail: taking it off took too long");
                        break;
                    }
                    match tokio::time::timeout(UNLABEL_BATCH_WAIT, self.apply_keywords(batch, &off)).await {
                        Ok(Ok(())) => {}
                        Ok(Err(error)) => tracing::debug!("Couldn't take a deleted label off some mail: {error}"),
                        Err(_) => tracing::debug!("Taking a deleted label off some mail took too long"),
                    }
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
            _ => {
                let entries = self.inner.store.label_log(message_ids.as_deref(), limit)?;
                Ok(Value::Array(entries.iter().map(log_json).collect()))
            }
        }
    }

    pub async fn assist_undo_labels(&self, scope: &str, log_ids: &[String]) -> Result<()> {
        match self.scope_target(scope).await? {
            Target::Server(client) => server::undo_labels(&client, log_ids).await?,
            _ => {
                // Taking a label off this way counts as by hand: the classifier and senders learn.
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
            match self.ai_target(&account_id).await? {
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
                target => {
                    for id in ids {
                        let labels = self.label_with_ai(&id, &target).await?;
                        out.insert(id, json!(labels));
                    }
                }
            }
        }
        self.assist_changed(None);
        Ok(Value::Object(out))
    }

    /// The newest mails of a scope's inboxes: this device's mailboxes, or one UwUMail account with
    /// its server's assistant (any other id is no scope).
    pub async fn assist_recent_inbox(&self, scope: &str, limit: u32) -> Result<Vec<String>> {
        let accounts = if scope == DEVICE_SCOPE {
            self.assist_split().await?.1
        } else {
            self.scope_target(scope).await?;
            vec![scope.to_string()]
        };
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
            match self.ai_target(account_id).await? {
                Target::Foreign(client) => {
                    let arguments = self.foreign_compose_arguments(&request, true).await;
                    server::stream_or_call(&client, "Assist/compose", arguments, sink.clone()).await
                }
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

    /// A compose request for the server that does this device's AI: the mail replied to goes
    /// along as `foreignMails` instead of its id (left out when it can't be read). With `download`,
    /// it is fetched when only its preview is stored.
    async fn foreign_compose_arguments(&self, request: &Value, download: bool) -> Value {
        // What the page may pass on; nothing else of the request goes to the server.
        const KEPT: [&str; 8] =
            ["mode", "instruction", "preset", "targetLanguage", "text", "subject", "wantSubject", "language"];
        let mut arguments: Value = KEPT
            .iter()
            .filter_map(|key| request.get(*key).map(|value| (key.to_string(), value.clone())))
            .collect::<Map<String, Value>>()
            .into();
        if let Some(mail) = self.device_reply_mail(request, download).await {
            arguments["foreignMails"] = json!([foreign::mail(&mail, None)]);
        }
        arguments
    }

    /// The mail a draft replies to (`replyToEmailId`), for this device's AI: only mail of a
    /// mailbox whose AI is this device's too. A UwUMail account's mail stays with its own server's
    /// assistant, whatever id the page passes; `None` then, or when it can't be read.
    async fn device_reply_mail(&self, request: &Value, download: bool) -> Option<MailText> {
        let reply = text_arg(request, "replyToEmailId")?;
        let owner = self.inner.store.locations(&[reply.to_string()]).ok()?.pop()?.account_id;
        if !matches!(self.assist_target(&owner).await, Ok(Target::Device)) {
            return None;
        }
        self.stored_mail(reply, mail::MAX_MAIL_CHARS, download).await.ok()
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
        let reply_to = self.device_reply_mail(request, download).await;
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
            let mut answer = match self.ai_target(&last.account_id).await? {
                Target::Foreign(client) => {
                    let arguments = json!({ "foreignMails": foreign_thread(&messages), "language": language });
                    server::stream_or_call(&client, "Assist/summarize", arguments, sink.clone()).await?
                }
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
        let mut answer = match self.ai_target(&message.account_id).await? {
            Target::Server(client) => {
                let (_, remote) = self.remote_id(message_id)?;
                server::spam_check(&client, &remote, language).await?
            }
            Target::Foreign(client) => {
                let mail = self.raw_mail(&message).await?;
                let foreign = foreign::mail(&mail, Some(self.in_junk(&message.id)?));
                server::call(&client, "Assist/spamCheck", json!({ "foreignMails": [foreign], "language": language }))
                    .await?
            }
            Target::Device => self.spam_check_on_device(&message, language).await?,
        };
        answer["emailId"] = json!(message_id);
        Ok(answer)
    }

    /// A mail read from its raw form, with all its headers: for the spam check.
    async fn raw_mail(&self, message: &Message) -> Result<MailText> {
        let location = self
            .inner
            .store
            .locations(std::slice::from_ref(&message.id))?
            .pop()
            .ok_or_else(|| Error::assist("notFound", "This mail no longer exists."))?;
        let raw = self.inner.raw_message(&location).await?;
        Ok(MailText::from_raw(message, &raw, mail::MAX_MAIL_CHARS))
    }

    /// Whether a mail is in its mailbox's junk folder.
    fn in_junk(&self, message_id: &str) -> Result<bool> {
        Ok(self
            .inner
            .store
            .message_roles(&[message_id.to_string()])?
            .first()
            .is_some_and(|(_, _, role)| role.as_deref() == Some("junk")))
    }

    async fn spam_check_on_device(&self, message: &Message, language: Option<&str>) -> Result<Value> {
        let mail = self.raw_mail(message).await?;
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
        let in_junk = self.in_junk(&message.id)?;
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
        match self.ai_target(&message.account_id).await? {
            Target::Server(client) => {
                let (_, remote) = self.remote_id(message_id)?;
                Ok(server_events(server::extract_events(&client, &remote, include_images).await?))
            }
            Target::Foreign(client) => {
                // The server can't read the pictures of mail it doesn't have.
                let mail = self.stored_mail(message_id, mail::MAX_MAIL_CHARS, true).await?;
                let arguments = json!({ "foreignMails": [foreign::mail(&mail, None)], "includeImages": false });
                Ok(server_events(server::call(&client, "Assist/extractEvents", arguments).await?))
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
    /// `Assist/summarize`, `Assist/spamCheck`, `Assist/extractEvents` or `AssistLabel/suggest`,
    /// `arguments` what the page passes to that call (the app's ids). A UwUMail account asks its
    /// server (`Assist/estimate`), and so does a mailbox whose AI that server does, with the mail
    /// that would go along; `None` when that server is older and doesn't know the method.
    /// Everything else is counted here with the same prompt, never downloading, reading pictures
    /// or asking a model.
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
        let (client, remote) = match self.ai_target(&account).await? {
            Target::Device => {
                return self.estimate_on_device(&account, method, &arguments, &messages, &currency).await.map(Some);
            }
            Target::Foreign(client) => {
                let remote = self.foreign_estimate_arguments(method, &arguments, &messages).await?;
                (client, remote)
            }
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
                (client, remote)
            }
        };
        let mut remote = remote;
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
            Err(error) if matches!(error.assist_kind(), Some("unknownMethod" | "unknownCapability")) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// The arguments of a call for the server that does this device's AI, as the call itself would
    /// send them, from what is stored (an estimate never downloads).
    async fn foreign_estimate_arguments(
        &self,
        method: Method,
        arguments: &Value,
        messages: &[Message],
    ) -> Result<Value> {
        let language = text_arg(arguments, "language");
        let last = || messages.last().ok_or_else(|| Error::assist("notFound", "This mail no longer exists."));
        Ok(match method {
            Method::Compose => self.foreign_compose_arguments(arguments, false).await,
            Method::Summarize => json!({ "foreignMails": foreign_thread(messages), "language": language }),
            Method::SpamCheck => {
                let message = last()?;
                let mail = MailText::from_stored(message, mail::MAX_MAIL_CHARS);
                json!({ "foreignMails": [foreign::mail(&mail, Some(self.in_junk(&message.id)?))], "language": language })
            }
            Method::ExtractEvents => {
                let mail = MailText::from_stored(last()?, mail::MAX_MAIL_CHARS);
                json!({ "foreignMails": [foreign::mail(&mail, None)], "includeImages": false })
            }
            Method::SuggestLabels => {
                let message = last()?;
                let mail = MailText::from_stored(message, mail::MAX_MAIL_CHARS);
                let suggest_new = arguments.get("suggestNew").and_then(Value::as_bool).unwrap_or(true);
                foreign_suggest_arguments(&mail, &self.device().labels()?, &message.keywords, suggest_new, language)
            }
        })
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
            Method::SuggestLabels => {
                let message =
                    messages.last().ok_or_else(|| Error::assist("notFound", "This mail no longer exists."))?;
                let suggest_new = arguments.get("suggestNew").and_then(Value::as_bool).unwrap_or(true);
                let labels = device.labels()?;
                let (prompt, new_labels) = suggest_prompt(message, &labels, suggest_new, language);
                let answer = estimate::Answer::Labels { labels: labels.len(), suggest_new: new_labels > 0 };
                let output = estimate::output_tokens(answer, &prompt);
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

    /// Sets (true) or takes off (false) own keywords by hand, e.g. labels. IMAP folders that keep
    /// no own keywords refuse with `not_supported`. A label of this device put on or taken off
    /// this way teaches its learned senders and its classifier (docs/labels.md of UwUMail Server).
    pub async fn set_keywords(&self, message_ids: &[String], keywords: &HashMap<String, bool>) -> Result<()> {
        let before = self.inner.store.messages_by_ids(message_ids)?;
        self.apply_keywords(message_ids, keywords).await?;
        if let Err(error) = self.learn_by_hand(&before, keywords).await {
            tracing::debug!("Labels didn't learn from a change by hand: {error}");
        }
        Ok(())
    }

    /// Sets or takes off own keywords, on the servers and here. Changes the engine makes itself
    /// (auto-labels, deleting a label) go through this and teach nothing.
    async fn apply_keywords(&self, message_ids: &[String], keywords: &HashMap<String, bool>) -> Result<()> {
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

    /// Learns from labels of this device the person put on or took off by hand, in mailboxes this
    /// device serves: putting one on counts the From address for it, makes the mail an example
    /// with it and learns one ordinary inbox mail as an example without any label; taking one off
    /// forgets the address for it and makes the mail an example without it.
    async fn learn_by_hand(&self, before: &[Message], changes: &HashMap<String, bool>) -> Result<()> {
        let labels = self.device().labels()?;
        let changed: Vec<(&Label, bool)> = changes
            .iter()
            .filter_map(|(keyword, on)| {
                let keyword = keyword.trim().to_lowercase();
                labels.iter().find(|label| label.keyword == keyword).map(|label| (label, *on))
            })
            .collect();
        if changed.is_empty() {
            return Ok(());
        }
        let mut served: HashMap<String, bool> = HashMap::new();
        let now = now_secs();
        for message in before {
            if !served.contains_key(&message.account_id) {
                let device = matches!(self.assist_target(&message.account_id).await, Ok(Target::Device));
                served.insert(message.account_id.clone(), device);
            }
            if served.get(&message.account_id) != Some(&true) {
                continue;
            }
            let mail = self.label_mail(message)?;
            let tokens = token_hashes(&mail);
            for (label, on) in &changed {
                if message.keywords.contains(&label.keyword) == *on {
                    continue;
                }
                let store = &self.inner.store;
                if !mail.from.is_empty() {
                    if *on {
                        store.count_label_sender(&label.id, &mail.from)?;
                    } else {
                        store.forget_label_sender(&label.id, &mail.from)?;
                    }
                }
                let newly = store.learn_label_example(
                    &message.id,
                    &tokens,
                    Some((&label.id, *on)),
                    now,
                    uwumail_labels::MAX_EXAMPLES,
                )?;
                if newly {
                    self.learn_ordinary_mail(message, &labels)?;
                }
            }
        }
        self.assist_changed(None);
        Ok(())
    }

    /// One recent unlabeled inbox mail of the same mailbox as an example without any label, so the
    /// classifier knows what ordinary mail looks like: of the newest 200 of the last 60 days that
    /// are no example yet, the one at `hash(labeled mail's id) mod their number`, like the server
    /// (which takes its numeric mail id; the app's ids are random UUIDs, so their FNV-1a hash
    /// picks as evenly).
    fn learn_ordinary_mail(&self, labeled: &Message, labels: &[Label]) -> Result<()> {
        let keywords: Vec<String> = labels.iter().map(|label| label.keyword.clone()).collect();
        let since = now_secs() - uwumail_labels::BACKGROUND_DAYS * 86_400;
        let mut candidates = self.inner.store.unlabeled_inbox(
            &labeled.account_id,
            since,
            &keywords,
            uwumail_labels::BACKGROUND_CANDIDATES + 1,
        )?;
        candidates.retain(|id| *id != labeled.id);
        candidates.truncate(uwumail_labels::BACKGROUND_CANDIDATES);
        if candidates.is_empty() {
            return Ok(());
        }
        let position = (uwumail_labels::token_hash(&labeled.id) as u64 % candidates.len() as u64) as usize;
        let pick = candidates[position].clone();
        let Some(message) = self.inner.store.messages_by_ids(&[pick])?.pop() else { return Ok(()) };
        let tokens = token_hashes(&self.label_mail(&message)?);
        self.inner.store.learn_label_example(&message.id, &tokens, None, now_secs(), uwumail_labels::MAX_EXAMPLES)?;
        Ok(())
    }

    /// A stored mail as labels without a model see it. Mail stored before its list headers were
    /// kept shows what its unsubscribe link says of them.
    fn label_mail(&self, message: &Message) -> Result<uwumail_labels::Mail> {
        let (mut headers, calendar) = self.inner.store.label_headers(&message.id)?;
        if headers.is_empty()
            && let Some(unsubscribe) = &message.unsubscribe
        {
            let link = [unsubscribe.url.as_deref(), unsubscribe.mailto.as_deref()]
                .into_iter()
                .flatten()
                .map(|uri| format!("<{uri}>"))
                .collect::<Vec<_>>()
                .join(", ");
            headers.push(("list-unsubscribe".into(), link));
            if unsubscribe.one_click {
                headers.push(("list-unsubscribe-post".into(), "List-Unsubscribe=One-Click".into()));
            }
        }
        let attachments = message
            .attachments
            .iter()
            .map(|a| uwumail_labels::Attachment { name: a.filename.clone(), content_type: a.mime_type.to_lowercase() })
            .collect();
        Ok(uwumail_labels::Mail::new(
            &message.from.email,
            &message.subject,
            &mail::body_text(message),
            attachments,
            calendar,
            headers,
        ))
    }

    /// Puts this device's labels on a new mail by their rules, detectors, learned senders and
    /// classifiers, and logs each. `examples` holds the classifier's examples once read. Returns
    /// the label ids set.
    async fn label_without_ai(
        &self,
        message: &Message,
        labels: &[Label],
        examples: &mut Option<Vec<LabelExample>>,
    ) -> Result<Vec<String>> {
        let mail = self.label_mail(message)?;
        let rules: Vec<uwumail_labels::Label<'_>> = labels
            .iter()
            .enumerate()
            .map(|(index, label)| uwumail_labels::Label {
                id: index as i64,
                keyword: &label.keyword,
                rules: label.rules.as_ref(),
                detector: label.detector.as_deref().and_then(uwumail_labels::Detector::parse),
                learn_senders: label.learn_senders,
                classifier: label.classifier,
            })
            .collect();
        let index_of = |id: &str| labels.iter().position(|label| label.id == id).map(|index| index as i64);
        let mut knowledge = uwumail_labels::Knowledge::default();
        if !mail.from.is_empty() {
            for (id, count) in self.inner.store.label_senders(&mail.from)? {
                if let Some(index) = index_of(&id) {
                    knowledge.senders.insert(index, count);
                }
            }
        }
        let tokens = token_hashes(&mail);
        if labels.iter().any(|label| label.classifier) {
            if examples.is_none() {
                *examples = Some(self.inner.store.label_examples()?);
            }
            knowledge.models = models(labels, examples.as_deref().unwrap_or_default(), &tokens);
        }
        let decisions = uwumail_labels::decide(&rules, &mail, &message.keywords, &knowledge, &tokens);
        if decisions.is_empty() {
            return Ok(Vec::new());
        }
        let wanted: HashMap<String, bool> = decisions.iter().map(|d| (d.keyword.clone(), true)).collect();
        self.apply_keywords(std::slice::from_ref(&message.id), &wanted).await?;
        let mut set = Vec::new();
        for decision in decisions {
            let label = &labels[decision.label_id as usize];
            self.log_label(
                message,
                label,
                decision.source.as_str(),
                decision.code,
                &decision.params,
                decision.reason,
                None,
            )?;
            set.push(label.id.clone());
        }
        Ok(set)
    }

    /// Keeps a label put on by itself in the log.
    #[allow(clippy::too_many_arguments)]
    fn log_label(
        &self,
        message: &Message,
        label: &Label,
        source: &str,
        code: &str,
        params: &Value,
        reason: String,
        who: Option<(String, String)>,
    ) -> Result<()> {
        let _ = self.inner.store.forget_label_log_before(now_secs() - LOG_DAYS * 86_400, LOG_KEPT);
        let (provider_name, model) = who.unzip();
        self.inner.store.insert_label_log(&LabelLogRecord {
            id: format!("l{}", uuid::Uuid::new_v4().simple()),
            account_id: message.account_id.clone(),
            message_id: message.id.clone(),
            label_id: label.id.clone(),
            name: label.name.clone(),
            keyword: label.keyword.clone(),
            reason,
            source: source.into(),
            code: code.into(),
            params: params.to_string(),
            provider_name,
            model,
            created_at: now_secs(),
            undone: false,
        })
    }

    /// Asks a model which of this device's labels not on a mail yet fit (never taking one off):
    /// this device's provider, or the server that does its AI. Sets those and logs each. Returns
    /// the label ids set.
    async fn label_with_ai(&self, message_id: &str, target: &Target) -> Result<Vec<String>> {
        let message = self
            .inner
            .store
            .messages_by_ids(&[message_id.to_string()])?
            .pop()
            .ok_or_else(|| Error::assist("notFound", "This mail no longer exists."))?;
        let missing: Vec<Label> =
            self.device().labels()?.into_iter().filter(|label| !message.keywords.contains(&label.keyword)).collect();
        if missing.is_empty() {
            return Ok(Vec::new());
        }
        let (picks, who): (Vec<(Label, String)>, (String, String)) = match target {
            Target::Foreign(client) => {
                self.count_server_auto_label()?;
                let mail = MailText::from_stored(&message, mail::MAX_MAIL_CHARS);
                let arguments = foreign_suggest_arguments(&mail, &missing, &message.keywords, false, None);
                let answer = server::call(client, "AssistLabel/suggest", arguments).await?;
                let picks = answer
                    .get("verdicts")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|verdict| verdict.get("fits").and_then(Value::as_bool) == Some(true))
                    .filter_map(|verdict| {
                        let name = verdict.get("name").and_then(Value::as_str)?.trim().to_lowercase();
                        let label = missing.iter().find(|label| label.name.to_lowercase() == name)?;
                        let reason = verdict.get("reason").and_then(Value::as_str).unwrap_or_default();
                        Some((label.clone(), validate::clean(&reason.replace('\n', " "), 300)))
                    })
                    .collect();
                let text = |key: &str| answer.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
                (picks, (text("providerName"), text("model")))
            }
            Target::Device => {
                let mail = MailText::from_stored(&message, mail::LABEL_MAIL_CHARS);
                let list: Vec<(String, String)> =
                    missing.iter().map(|l| (l.name.clone(), l.description.clone())).collect();
                let prompt = prompts::labels(&mail, &list);
                let answer = estimate::Answer::Labels { labels: missing.len(), suggest_new: false };
                let typical = estimate::output_tokens(answer, &prompt);
                let (answer, effective) =
                    self.device().ask(self.assist_http()?, Feature::AutoLabels, &prompt, typical, None).await?;
                let Some(parsed) = validate::json_answer(&answer.text) else {
                    return Err(Error::assist("providerFailed", "The model's answer had no labels in the asked form."));
                };
                let picks = validate::parse_labels(&parsed, &missing)
                    .into_iter()
                    .map(|pick| (pick.label, pick.reason))
                    .collect();
                (picks, (effective.provider.name.clone(), effective.model.clone()))
            }
            Target::Server(_) => return Err(Error::assist("assistUnavailable", "Its server labels this mail.")),
        };
        let picks: Vec<(Label, String)> =
            picks.into_iter().filter(|(l, _)| !message.keywords.contains(&l.keyword)).collect();
        if picks.is_empty() {
            return Ok(Vec::new());
        }
        let wanted: HashMap<String, bool> = picks.iter().map(|(label, _)| (label.keyword.clone(), true)).collect();
        self.apply_keywords(std::slice::from_ref(&message.id), &wanted).await?;
        let mut set = Vec::new();
        for (label, reason) in picks {
            self.log_label(&message, &label, "ai", "ai", &json!({}), reason, Some(who.clone()))?;
            set.push(label.id);
        }
        Ok(set)
    }

    /// Counts a request of auto-labels to the server that does this device's AI, today's.
    fn count_server_auto_label(&self) -> Result<()> {
        let today = local::utc_day(now_secs());
        let count = self.server_auto_labels_today()?;
        self.inner.store.set_assist_setting("serverAutoLabels", Some(&format!("{today} {}", count + 1)))
    }

    /// Requests of auto-labels to the server that does this device's AI today.
    fn server_auto_labels_today(&self) -> Result<u64> {
        let today = local::utc_day(now_secs());
        Ok(self
            .inner
            .store
            .assist_setting("serverAutoLabels")?
            .and_then(|text| {
                let (day, count) = text.split_once(' ')?;
                (day == today).then(|| count.parse().ok()).flatten()
            })
            .unwrap_or(0))
    }

    /// Whether the model may still judge labels today: auto-labels cost money on most providers.
    fn ai_labels_left(&self, target: &Target) -> bool {
        let used = match target {
            Target::Foreign(_) => self.server_auto_labels_today(),
            _ => self.device().requests_today(Feature::AutoLabels),
        };
        used.unwrap_or(u64::MAX) < local::AUTO_LABELS_PER_DAY
    }

    /// Labels new inbox mail of a mailbox this device serves: first without a model (with
    /// `nonAiLabels` on, which needs no provider at all), then the model judges the labels still
    /// missing (with `autoLabels` on and a provider, or the server that does this device's AI),
    /// within the day's limit.
    async fn auto_label(&self, account_id: &str, message_ids: Vec<String>) {
        let device = self.device();
        let Ok(labels) = device.labels() else { return };
        let non_ai = device.non_ai_labels_on().unwrap_or(false);
        let ai_on = device.auto_labels_on().unwrap_or(false);
        if labels.is_empty() || (!non_ai && !ai_on) {
            return;
        }
        let Ok(Target::Device) = self.assist_target(account_id).await else { return };
        let mut ai = match ai_on {
            true => match self.foreign_server().await {
                Ok(Some(client)) => Some(Target::Foreign(client)),
                Ok(None) if device.effective(Feature::AutoLabels).ok().flatten().is_some() => Some(Target::Device),
                // Unset without a provider, or the chosen server can't do it now: labels without a
                // model only.
                _ => None,
            },
            false => None,
        };
        let Ok(account) = self.inner.store.account(account_id) else { return };
        let Ok(roles) = self.inner.store.message_roles(&message_ids) else { return };
        let mut examples = None;
        let mut labelled = false;
        for (id, _, _) in roles.into_iter().filter(|(_, _, role)| role.as_deref() == Some("inbox")).take(LABELS_AT_ONCE)
        {
            let Some(message) =
                self.inner.store.messages_by_ids(std::slice::from_ref(&id)).ok().and_then(|mut m| m.pop())
            else {
                continue;
            };
            if message.from.email.eq_ignore_ascii_case(&account.email) {
                continue;
            }
            if non_ai {
                match self.label_without_ai(&message, &labels, &mut examples).await {
                    Ok(set) => labelled |= !set.is_empty(),
                    // The server keeps no own keywords: nothing more to do for this mailbox now.
                    Err(error) if error.code == ErrorCode::NotSupported => break,
                    Err(error) => tracing::debug!("Labels without a model skipped a mail: {error}"),
                }
            }
            let Some(target) = &ai else { continue };
            if !self.ai_labels_left(target) {
                tracing::debug!("Auto-labels reached today's limit");
                ai = None;
                continue;
            }
            match self.label_with_ai(&id, target).await {
                Ok(set) => labelled |= !set.is_empty(),
                Err(error) if error.code == ErrorCode::NotSupported => break,
                Err(error) => {
                    tracing::debug!("Auto-labels skipped a mail: {error}");
                    if error.assist_kind() != Some("providerFailed") {
                        ai = None;
                    }
                }
            }
        }
        if labelled {
            self.assist_changed(Some(account_id));
        }
    }

    // ------------------------------------------------------ label again

    /// "Label again": a model judges every label for one mail (also those on it) and, with
    /// `suggest_new` (default) and when none fits, proposes up to two new labels. Changes nothing.
    /// The answer is `AssistLabel/suggest`'s with the app's message and label ids.
    pub async fn assist_suggest_labels(
        &self,
        message_id: &str,
        language: Option<&str>,
        suggest_new: Option<bool>,
    ) -> Result<Value> {
        let suggest_new = suggest_new.unwrap_or(true);
        let message = self
            .inner
            .store
            .messages_by_ids(&[message_id.to_string()])?
            .pop()
            .ok_or_else(|| Error::assist("notFound", "This mail no longer exists."))?;
        let mut answer = match self.ai_target(&message.account_id).await? {
            Target::Server(client) => {
                let (_, remote) = self.remote_id(message_id)?;
                let arguments = json!({ "emailId": remote, "suggestNew": suggest_new, "language": language });
                server::call(&client, "AssistLabel/suggest", arguments).await?
            }
            Target::Foreign(client) => {
                let labels = self.device().labels()?;
                let mail = self.stored_mail(message_id, mail::MAX_MAIL_CHARS, true).await?;
                let arguments = foreign_suggest_arguments(&mail, &labels, &message.keywords, suggest_new, language);
                let answer = server::call(&client, "AssistLabel/suggest", arguments).await?;
                foreign_suggestion(answer, &labels, &message.keywords, suggest_new)
            }
            Target::Device => {
                let labels = self.device().labels()?;
                let (_, new_labels) = suggest_prompt(&message, &labels, suggest_new, language);
                if labels.is_empty() && new_labels == 0 {
                    // Nothing to judge and nothing to propose: no model asked.
                    return Ok(json!({ "emailId": message_id, "verdicts": [], "newLabels": [], "providerId": null,
                                      "providerName": null, "model": null, "usage": null }));
                }
                // The body, downloaded once when only its preview is stored.
                self.stored_mail(message_id, mail::MAX_MAIL_CHARS, true).await?;
                let message = self.inner.store.messages_by_ids(&[message_id.to_string()])?.pop().unwrap_or(message);
                let (prompt, new_labels) = suggest_prompt(&message, &labels, suggest_new, language);
                let typical = estimate::output_tokens(
                    estimate::Answer::Labels { labels: labels.len(), suggest_new: new_labels > 0 },
                    &prompt,
                );
                let (answer, effective) =
                    self.device().ask(self.assist_http()?, Feature::AutoLabels, &prompt, typical, None).await?;
                let parsed = validate::json_answer(&answer.text).ok_or_else(|| {
                    Error::assist("providerFailed", "The model's answer had no verdicts in the asked form.")
                })?;
                let verdicts = validate::parse_verdicts(&parsed, &labels);
                let names: Vec<String> = labels.iter().map(|label| label.name.clone()).collect();
                let proposed = if verdicts.iter().any(|v| v.fits) {
                    Vec::new()
                } else {
                    validate::parse_new_labels(&parsed, &names, new_labels)
                };
                let mut out = local::answer_json(&effective, &answer);
                let verdicts: Vec<Value> = verdicts
                    .iter()
                    .map(|v| verdict_json(&v.label, &v.reason, v.fits, message.keywords.contains(&v.label.keyword)))
                    .collect();
                out.insert("verdicts".into(), Value::Array(verdicts));
                out.insert("newLabels".into(), serde_json::to_value(proposed)?);
                Value::Object(out)
            }
        };
        answer["emailId"] = json!(message_id);
        Ok(answer)
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

/// The token hashes of a mail, for the classifier.
fn token_hashes(mail: &uwumail_labels::Mail) -> Vec<i64> {
    uwumail_labels::tokens(mail).iter().map(|token| uwumail_labels::token_hash(token)).collect()
}

/// Per label index with its classifier on: what the examples say about these tokens.
fn models(labels: &[Label], examples: &[LabelExample], tokens: &[i64]) -> HashMap<i64, uwumail_labels::Model> {
    let wanted: HashSet<i64> = tokens.iter().copied().collect();
    let mut out: HashMap<i64, uwumail_labels::Model> = HashMap::new();
    let on: Vec<(i64, &str)> = labels
        .iter()
        .enumerate()
        .filter(|(_, label)| label.classifier)
        .map(|(index, label)| (index as i64, label.id.as_str()))
        .collect();
    for example in examples {
        let seen: HashSet<i64> = example.tokens.iter().copied().filter(|token| wanted.contains(token)).collect();
        for (index, id) in &on {
            let model = out.entry(*index).or_default();
            let with = example.labels.iter().any(|label| label == id);
            if with {
                model.positives += 1;
            } else {
                model.negatives += 1;
            }
            for token in &seen {
                let counts = model.counts.entry(*token).or_insert((0, 0));
                if with {
                    counts.0 += 1;
                } else {
                    counts.1 += 1;
                }
            }
        }
    }
    out
}

/// One verdict of "Label again" as the page gets it.
fn verdict_json(label: &Label, reason: &str, fits: bool, is_set: bool) -> Value {
    json!({ "labelId": label.id, "name": label.name, "reason": reason, "fits": fits, "isSet": is_set })
}

/// A server's `AssistLabel/suggest` answer about foreign mail, with this device's label ids: its
/// verdicts name labels, and names that aren't labels here are dropped, as are proposals that
/// don't fit this device's rules for labels.
fn foreign_suggestion(mut answer: Value, labels: &[Label], keywords: &[String], suggest_new: bool) -> Value {
    let verdicts: Vec<Value> = answer
        .get("verdicts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|verdict| {
            let name = verdict.get("name").and_then(Value::as_str)?.trim().to_lowercase();
            let label = labels.iter().find(|label| label.name.to_lowercase() == name)?;
            let reason = validate::clean(
                &verdict.get("reason").and_then(Value::as_str).unwrap_or_default().replace('\n', " "),
                300,
            );
            let fits = verdict.get("fits").and_then(Value::as_bool).unwrap_or(false);
            Some(verdict_json(label, &reason, fits, keywords.contains(&label.keyword)))
        })
        .collect();
    let names: Vec<String> = labels.iter().map(|label| label.name.clone()).collect();
    let room = if suggest_new && !verdicts.iter().any(|v| v["fits"] == true) {
        local::MAX_LABELS.saturating_sub(labels.len())
    } else {
        0
    };
    let proposed = validate::parse_new_labels(&answer, &names, room);
    answer["verdicts"] = Value::Array(verdicts);
    answer["newLabels"] = serde_json::to_value(proposed).unwrap_or_else(|_| json!([]));
    answer
}

/// `AssistLabel/suggest` arguments for the server that does this device's AI: the mail, and every
/// device label with whether the mail has it.
fn foreign_suggest_arguments(
    mail: &MailText,
    labels: &[Label],
    keywords: &[String],
    suggest_new: bool,
    language: Option<&str>,
) -> Value {
    let list: Vec<(String, String, bool)> = labels
        .iter()
        .map(|label| (label.name.clone(), label.description.clone(), keywords.contains(&label.keyword)))
        .collect();
    json!({
        "foreignMails": [foreign::mail(mail, None)],
        "foreignLabels": foreign::labels(&list),
        "suggestNew": suggest_new,
        "language": language,
    })
}

/// The prompt of "Label again" on this device, and how many new labels it may propose: at most
/// two, within the room left for labels, and none unless `suggest_new`.
fn suggest_prompt(message: &Message, labels: &[Label], suggest_new: bool, language: Option<&str>) -> (Prompt, usize) {
    let mail = MailText::from_stored(message, mail::LABEL_MAIL_CHARS);
    let list: Vec<(String, String)> = labels.iter().map(|l| (l.name.clone(), l.description.clone())).collect();
    let room = local::MAX_LABELS.saturating_sub(labels.len()).min(validate::MAX_NEW_LABELS);
    let new_labels = if suggest_new { room } else { 0 };
    (prompts::suggest_labels(&mail, &list, new_labels, language), new_labels)
}

/// A conversation for the server that does this device's AI: its latest mails, oldest first.
fn foreign_thread(messages: &[Message]) -> Value {
    let start = messages.len().saturating_sub(foreign::MAX_MAILS);
    let mails: Vec<MailText> =
        messages[start..].iter().map(|m| MailText::from_stored(m, mail::MAX_MAIL_CHARS)).collect();
    foreign::mails(&mails)
}

/// A server's `Assist/extractEvents` answer as the page gets it.
fn server_events(answer: Value) -> Value {
    let who = json!({
        "providerId": answer.get("providerId"),
        "providerName": answer.get("providerName"),
        "model": answer.get("model"),
        "usage": answer.get("usage"),
    });
    json!({ "events": answer.get("events").cloned().unwrap_or_else(|| json!([])), "answer": who })
}

/// A device label in the server's `AssistLabel` shape.
fn label_json(label: &Label, total: u32, unread: u32, examples: u64) -> Value {
    let mut value = serde_json::to_value(label).unwrap_or_else(|_| json!({}));
    value["totalEmails"] = json!(total);
    value["unreadEmails"] = json!(unread);
    value["examples"] = json!(examples);
    value
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
        "source": entry.source,
        "code": entry.code,
        "params": serde_json::from_str::<Value>(&entry.params).unwrap_or_else(|_| json!({})),
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
            source: "ai".into(),
            code: "ai".into(),
            params: "{}".into(),
            provider_name: Some("Ollama".into()),
            model: Some("llama3".into()),
            created_at: 0,
            undone: false,
        };
        let value = log_json(&entry);
        assert_eq!(value["emailId"], "m1");
        assert_eq!(value["createdAt"], "1970-01-01T00:00:00Z");
    }

    /// Another mail in the inbox of `engine_with_mail`'s mailbox, kept on this device only (so
    /// setting keywords asks no server). `extra` are header lines; `pdf` an attached file name.
    fn add_mail(
        engine: &Engine,
        uid: u32,
        from: &str,
        subject: &str,
        text: &str,
        extra: &[&str],
        pdf: Option<&str>,
    ) -> String {
        use crate::model::{FolderRole, MessageFlags};
        let store = &engine.inner.store;
        let inbox = store.folder_by_role("acc", FolderRole::Inbox).unwrap().unwrap().id;
        let date = chrono::Utc::now().to_rfc2822();
        let mut raw = format!(
            "From: {from}\r\nTo: mini@example.org\r\nSubject: {subject}\r\nDate: {date}\r\nMessage-ID: <{uid}@example.com>\r\n"
        );
        for line in extra {
            raw.push_str(line);
            raw.push_str("\r\n");
        }
        match pdf {
            Some(name) => raw.push_str(&format!(
                "MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{text}\r\n--b\r\nContent-Type: application/pdf; name=\"{name}\"\r\nContent-Disposition: attachment; filename=\"{name}\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--b--\r\n"
            )),
            None => raw.push_str(&format!("Content-Type: text/plain; charset=utf-8\r\n\r\n{text}\r\n")),
        }
        let parsed = crate::mime::parse(raw.as_bytes());
        let id = store
            .insert_message("acc", &inbox, uid, MessageFlags::default(), raw.len() as u64, None, &parsed)
            .unwrap()
            .unwrap();
        store.unlink_for_tests(&id);
        id
    }

    fn keywords(engine: &Engine, id: &str) -> Vec<String> {
        engine.inner.store.messages_by_ids(&[id.to_string()]).unwrap().pop().unwrap().keywords
    }

    #[tokio::test]
    async fn labels_go_on_by_rules_and_detectors_without_any_provider() {
        let (_dir, engine, first) = engine_with_mail();
        engine.inner.store.unlink_for_tests(&first);
        let invoices = engine
            .assist_create_label(DEVICE_SCOPE, json!({ "name": "Rechnungen", "detector": "invoice" }))
            .await
            .unwrap();
        assert_eq!((invoices["learnSenders"].as_bool(), invoices["classifier"].as_bool()), (Some(true), Some(true)));
        assert_eq!((invoices["totalEmails"].as_u64(), invoices["examples"].as_u64()), (Some(0), Some(0)));
        let rules = json!({ "match": "any", "conditions": [{ "field": "subject", "value": " sommerfest " }] });
        engine.assist_create_label(DEVICE_SCOPE, json!({ "name": "Feiern", "rules": rules })).await.unwrap();
        engine
            .assist_create_label(DEVICE_SCOPE, json!({ "name": "Newsletter", "detector": "newsletter" }))
            .await
            .unwrap();
        let bill = add_mail(
            &engine,
            2,
            "Stadtwerke <rechnung@stadtwerke.example>",
            "Ihre Rechnung September",
            "Anbei.",
            &[],
            Some("Rechnung_4711.pdf"),
        );
        let news = add_mail(
            &engine,
            3,
            "Shop <news@shop.example>",
            "Neues im Herbst",
            "Hallo",
            &["List-Unsubscribe: <https://shop.example/u>", "List-Id: <herbst.shop.example>"],
            None,
        );
        let own = add_mail(&engine, 4, "Mini <mini@example.org>", "Rechnung an mich", "x", &[], Some("Rechnung_1.pdf"));
        assert!(engine.device().effective(Feature::AutoLabels).unwrap().is_none(), "no provider at all");

        engine.auto_label("acc", vec![first.clone(), bill.clone(), news.clone(), own.clone()]).await;
        assert_eq!(keywords(&engine, &first), ["feiern"]);
        assert_eq!(keywords(&engine, &bill), ["rechnungen"]);
        assert_eq!(keywords(&engine, &news), ["newsletter"]);
        assert!(keywords(&engine, &own).is_empty(), "mail sent by the mailbox itself");

        let log = engine.assist_label_log(DEVICE_SCOPE, Some(vec![bill.clone()]), None).await.unwrap();
        assert_eq!(log[0]["source"], "detector");
        assert_eq!(log[0]["code"], "invoice");
        assert_eq!(log[0]["params"], json!({ "attachment": "Rechnung_4711.pdf" }));
        assert_eq!(log[0]["reason"], "Looks like an invoice: PDF attachment \"Rechnung_4711.pdf\"");
        assert!(log[0]["providerName"].is_null());
        let log = engine.assist_label_log(DEVICE_SCOPE, Some(vec![first.clone()]), None).await.unwrap();
        assert_eq!((log[0]["source"].as_str(), log[0]["params"]["match"].as_str()), (Some("rule"), Some("any")));

        let labels = engine.assist_labels(DEVICE_SCOPE).await.unwrap();
        assert_eq!(labels[0]["totalEmails"], 1);
        assert_eq!(labels[1]["rules"]["conditions"][0]["value"], "sommerfest", "trimmed");

        // Switched off, nothing goes on.
        engine.assist_update_settings(DEVICE_SCOPE, json!({ "nonAiLabels": false })).await.unwrap();
        assert_eq!(engine.assist_settings(DEVICE_SCOPE).await.unwrap()["nonAiLabels"], false);
        let later = add_mail(
            &engine,
            5,
            "Stadtwerke <rechnung@stadtwerke.example>",
            "Rechnung Oktober",
            "x",
            &[],
            Some("Rechnung_4712.pdf"),
        );
        engine.auto_label("acc", vec![later.clone()]).await;
        assert!(keywords(&engine, &later).is_empty());
    }

    #[tokio::test]
    async fn senders_are_learned_from_hand_labels_only_and_forgotten() {
        let (_dir, engine, _) = engine_with_mail();
        let label = engine.assist_create_label(DEVICE_SCOPE, json!({ "name": "Leni" })).await.unwrap();
        let label_id = label["id"].as_str().unwrap().to_string();
        let from = "Leni <leni@example.com>";
        let mails: Vec<String> =
            (10..14).map(|uid| add_mail(&engine, uid, from, "Hallo", "Wie geht's?", &[], None)).collect();
        let other = add_mail(&engine, 20, "Tom <tom@example.com>", "Hi", "Na?", &[], None);
        let on: HashMap<String, bool> = [("leni".to_string(), true)].into();
        let off: HashMap<String, bool> = [("leni".to_string(), false)].into();
        let senders = || engine.inner.store.label_senders("leni@example.com").unwrap().get(&label_id).copied();

        // Changes the engine makes itself teach nothing.
        engine.apply_keywords(&mails[..1], &on).await.unwrap();
        assert_eq!(senders(), None);
        engine.apply_keywords(&mails[..1], &off).await.unwrap();

        engine.set_keywords(&mails[..1], &on).await.unwrap();
        engine.set_keywords(&mails[..1], &on).await.unwrap();
        assert_eq!(senders(), Some(1), "only a real change counts");
        engine.set_keywords(&mails[1..2], &on).await.unwrap();
        assert_eq!(senders(), Some(2));
        // Each hand label also learns one ordinary inbox mail (which may be labeled by hand later).
        let examples = engine.inner.store.label_examples().unwrap();
        assert_eq!(examples.iter().filter(|e| e.labels == [label_id.clone()]).count(), 2);
        assert!((3..=4).contains(&examples.len()), "{examples:?}");
        assert_eq!(engine.assist_labels(DEVICE_SCOPE).await.unwrap()[0]["examples"], 2);

        engine.auto_label("acc", vec![mails[2].clone(), other.clone()]).await;
        assert_eq!(keywords(&engine, &mails[2]), ["leni"]);
        assert!(keywords(&engine, &other).is_empty());
        let log = engine.assist_label_log(DEVICE_SCOPE, Some(vec![mails[2].clone()]), None).await.unwrap();
        assert_eq!(log[0]["params"], json!({ "address": "leni@example.com", "count": 2 }));
        assert_eq!(log[0]["reason"], "leni@example.com got this label by hand 2 times");

        // Undoing counts as by hand: the sender is forgotten.
        let log_id = log[0]["id"].as_str().unwrap().to_string();
        engine.assist_undo_labels(DEVICE_SCOPE, &[log_id]).await.unwrap();
        assert!(keywords(&engine, &mails[2]).is_empty());
        assert_eq!(senders(), None);
        engine.auto_label("acc", vec![mails[3].clone()]).await;
        assert!(keywords(&engine, &mails[3]).is_empty());

        // Deleting the label forgets what it learned.
        engine.set_keywords(&mails[..1], &off).await.unwrap();
        engine.set_keywords(&mails[..1], &on).await.unwrap();
        engine.assist_delete_label(DEVICE_SCOPE, &label_id).await.unwrap();
        assert_eq!(senders(), None);
        assert!(engine.inner.store.label_example_counts().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_deleted_label_comes_off_all_its_mail_not_only_the_logged() {
        let (_dir, engine, first) = engine_with_mail();
        engine.inner.store.unlink_for_tests(&first);
        let label = engine.assist_create_label(DEVICE_SCOPE, json!({ "name": "Verein" })).await.unwrap();
        let keep = engine.assist_create_label(DEVICE_SCOPE, json!({ "name": "Privat" })).await.unwrap();
        let mut mails = vec![first];
        mails.extend((2..6).map(|uid| add_mail(&engine, uid, "Leni <leni@example.com>", "Hallo", "x", &[], None)));
        // Put on by hand, by the engine and by other programs: none of it is in the log.
        engine.set_keywords(&mails[..2], &[("verein".to_string(), true)].into()).await.unwrap();
        engine.apply_keywords(&mails[2..], &[("verein".to_string(), true)].into()).await.unwrap();
        engine.apply_keywords(&mails[..1], &[("privat".to_string(), true)].into()).await.unwrap();
        assert!(engine.inner.store.label_log(None, 500).unwrap().is_empty());
        let before = engine.inner.store.messages_with_keyword("verein", &["acc".to_string()], 100).unwrap();
        assert_eq!(before.len(), mails.len());

        engine.assist_delete_label(DEVICE_SCOPE, label["id"].as_str().unwrap()).await.unwrap();
        for id in &mails[1..] {
            assert!(keywords(&engine, id).is_empty(), "{id}");
        }
        assert_eq!(keywords(&engine, &mails[0]), ["privat"], "other labels stay");
        let labels = engine.assist_labels(DEVICE_SCOPE).await.unwrap();
        assert_eq!(labels.as_array().unwrap().len(), 1);
        assert_eq!(labels[0]["id"], keep["id"]);
        let gone = engine.assist_delete_label(DEVICE_SCOPE, label["id"].as_str().unwrap()).await.unwrap_err();
        assert_eq!(gone.assist_kind(), Some("notFound"));
    }

    #[test]
    fn the_classifier_learns_from_examples() {
        let mut labels = vec![Label::named("g1", "Verein", "verein"), Label::named("g2", "Aus", "aus")];
        labels[1].classifier = false;
        let hashes = |words: &[&str]| words.iter().map(|w| uwumail_labels::token_hash(w)).collect::<Vec<_>>();
        let mut examples = Vec::new();
        for n in 0..15 {
            let mut tokens = hashes(&["subject:training", "mannschaft", "vorstand"]);
            tokens.push(n);
            examples.push(LabelExample { labels: vec!["g1".into()], tokens });
            examples.push(LabelExample { labels: vec![], tokens: hashes(&["angebot", "rabatt", &format!("w{n}")]) });
        }
        let mail = hashes(&["subject:training", "mannschaft", "vorstand", "neu"]);
        let found = models(&labels, &examples, &mail);
        assert!(!found.contains_key(&1), "its classifier is off");
        let model = &found[&0];
        assert_eq!((model.positives, model.negatives), (15, 15));
        assert_eq!(model.counts[&uwumail_labels::token_hash("mannschaft")], (15, 0));
        assert!(model.classify(&mail).is_some());
        assert!(model.classify(&hashes(&["angebot", "rabatt"])).is_none());
        // Fewer than 15 on either side: nothing yet.
        assert!(models(&labels, &examples[..20], &mail)[&0].classify(&mail).is_none());
    }

    #[test]
    fn suggestions_about_foreign_mail_name_this_devices_labels() {
        let labels = vec![Label::named("g1", "Rechnungen", "rechnungen"), Label::named("g2", "Reisen", "reisen")];
        let answer = json!({
            "emailId": null,
            "verdicts": [
                { "labelId": null, "name": "rechnungen", "reason": "Eine Rechnung.", "fits": true, "isSet": false },
                { "labelId": null, "name": "Unbekannt", "reason": "x", "fits": true, "isSet": false },
                { "labelId": null, "name": "Reisen", "reason": "Keine Reise.", "fits": false, "isSet": false }
            ],
            "newLabels": [{ "name": "Strom", "description": "", "color": "#112233", "reason": "x" }],
            "providerName": "Mistral", "model": "mistral-small-latest"
        });
        let mapped = foreign_suggestion(answer, &labels, &["reisen".to_string()], true);
        assert_eq!(mapped["verdicts"].as_array().unwrap().len(), 2);
        assert_eq!(
            mapped["verdicts"][0],
            json!({ "labelId": "g1", "name": "Rechnungen", "reason": "Eine Rechnung.", "fits": true, "isSet": false })
        );
        assert_eq!(mapped["verdicts"][1]["isSet"], true, "what this device knows");
        assert_eq!(mapped["newLabels"], json!([]), "a label fits: nothing new");
        assert_eq!(mapped["providerName"], "Mistral");
    }

    /// A UwUMail server with the assistant on 127.0.0.1: its session (with `foreignMail` as given)
    /// and `answer(method, arguments)` for every call, which it keeps.
    async fn fake_uwumail(
        foreign_mail: bool,
        answer: fn(&str, &Value) -> Value,
    ) -> (String, Arc<Mutex<Vec<(String, Value)>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&calls);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buffer = Vec::new();
                let mut chunk = [0u8; 8192];
                let head = loop {
                    if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                        break end;
                    }
                    match socket.read(&mut chunk).await {
                        Ok(0) | Err(_) => break usize::MAX,
                        Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                    }
                };
                if head == usize::MAX {
                    continue;
                }
                let text = String::from_utf8_lossy(&buffer[..head]).to_lowercase();
                let length: usize = text
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse().ok())
                    .unwrap_or(0);
                let mut body = buffer[head + 4..].to_vec();
                while body.len() < length {
                    match socket.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => body.extend_from_slice(&chunk[..n]),
                    }
                }
                let reply = if text.starts_with("get") {
                    json!({
                        "capabilities": { crate::jmap::CORE: {}, crate::jmap::MAIL: {}, "urn:uwumail:jmap:assist": {} },
                        "accounts": { "a1": { "name": "mini@uwu.test", "accountCapabilities": {
                            "urn:uwumail:jmap:assist": {
                                "features": { "compose": true, "summarize": true, "spamCheck": true,
                                              "extractEvents": true, "autoLabels": true },
                                "maxLabels": 30, "foreignMail": foreign_mail
                            } } } },
                        "primaryAccounts": { crate::jmap::MAIL: "a1" },
                        "username": "mini@uwu.test",
                        "apiUrl": "/api",
                        "downloadUrl": "/download/{accountId}/{blobId}/{name}?type={type}",
                        "uploadUrl": "/upload/{accountId}/",
                        "state": "s1"
                    })
                } else {
                    let request: Value = serde_json::from_slice(&body).unwrap_or_default();
                    let responses: Vec<Value> = request["methodCalls"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default()
                        .iter()
                        .map(|call| {
                            let name = call[0].as_str().unwrap_or_default().to_string();
                            seen.lock().unwrap().push((name.clone(), call[1].clone()));
                            json!([name, answer(&name, &call[1]), call[2]])
                        })
                        .collect();
                    json!({ "methodResponses": responses, "sessionState": "s1" })
                };
                let body = reply.to_string();
                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(body.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        (format!("{base}/.well-known/jmap"), calls)
    }

    /// `engine_with_mail` plus a UwUMail mailbox `uwu` on the fake server.
    async fn engine_with_uwumail(
        foreign_mail: bool,
        answer: fn(&str, &Value) -> Value,
    ) -> (tempfile::TempDir, Engine, String, Arc<Mutex<Vec<(String, Value)>>>) {
        use crate::model::{AccountColor, AuthKind, Security, ServerSettings};
        use crate::secrets::Secret;
        use crate::store::AccountRecord;
        let (dir, engine, id) = engine_with_mail();
        engine.inner.store.unlink_for_tests(&id);
        let (url, calls) = fake_uwumail(foreign_mail, answer).await;
        engine
            .inner
            .store
            .insert_account(&AccountRecord {
                id: "uwu".into(),
                name: "UwU".into(),
                email: "mini@uwu.test".into(),
                display_name: "Mini".into(),
                color: AccountColor::Pink,
                auth: AuthKind::Password,
                username: "mini@uwu.test".into(),
                imap: ServerSettings { host: "uwu.test".into(), port: 993, security: Security::Tls },
                smtp: ServerSettings { host: "uwu.test".into(), port: 465, security: Security::Tls },
                protocol: Protocol::Jmap,
                jmap_url: Some(url),
            })
            .unwrap();
        engine.inner.secrets.set("uwu", &Secret::Password { password: "geheim".into() }).unwrap(); // gitleaks:allow
        (dir, engine, id, calls)
    }

    fn server_answers(method: &str, arguments: &Value) -> Value {
        let who = json!({ "providerId": "q1", "providerName": "Mistral", "model": "mistral-small-latest",
                          "usage": { "inputTokens": 900, "outputTokens": 80, "reasoningTokens": 0 } });
        let mut answer = match method {
            "AssistLabel/suggest" => {
                let verdicts: Vec<Value> = arguments["foreignLabels"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|label| {
                        json!({ "labelId": null, "name": label["name"], "reason": "Ein Fest.",
                                         "fits": label["name"] == "Feiern", "isSet": label["isSet"] })
                    })
                    .collect();
                json!({ "emailId": null, "verdicts": verdicts, "newLabels": [] })
            }
            "Assist/summarize" => json!({ "emailId": null, "threadId": null, "summary": "Ein Fest im Park." }),
            "Assist/estimate" => json!({ "method": arguments["method"], "inputTokens": 1000, "outputTokens": 40 }),
            _ => json!({}),
        };
        for (key, value) in who.as_object().unwrap() {
            answer[key] = value.clone();
        }
        answer
    }

    #[tokio::test]
    async fn another_mailbox_uses_the_uwumail_servers_ai_only_when_chosen() {
        let (_dir, engine, id, calls) = engine_with_uwumail(true, server_answers).await;
        engine
            .device()
            .create_provider(
                &json!({ "kind": "ollama", "name": "Ollama", "baseUrl": "http://127.0.0.1:9", "model": "llama3" }),
            )
            .unwrap();
        let foreign = |calls: &Arc<Mutex<Vec<(String, Value)>>>| {
            calls.lock().unwrap().iter().filter(|(_, args)| args.to_string().contains("foreignMails")).count()
        };

        // Off (the default): the device counts itself, nothing goes to the server.
        let local =
            engine.assist_estimate("acc", "Assist/summarize", json!({ "emailId": id }), None).await.unwrap().unwrap();
        assert_eq!(local["providerName"], "Ollama");
        let scopes = engine.assist_scopes().await.unwrap();
        let device = scopes.as_array().unwrap().iter().find(|s| s["id"] == DEVICE_SCOPE).unwrap().clone();
        assert_eq!(device["options"]["foreignServers"], json!(["uwu"]));
        assert_eq!(device["options"]["maxLabelConditions"], 10);
        assert_eq!(engine.assist_settings(DEVICE_SCOPE).await.unwrap()["serverAssist"], Value::Null);
        assert_eq!(foreign(&calls), 0);

        // Only a UwUMail mailbox whose server allows it can be chosen.
        for bad in ["nope", "acc"] {
            let refused =
                engine.assist_update_settings(DEVICE_SCOPE, json!({ "serverAssist": bad })).await.unwrap_err();
            assert_eq!(refused.assist.unwrap().properties, ["serverAssist"]);
        }
        engine.assist_update_settings(DEVICE_SCOPE, json!({ "serverAssist": "uwu" })).await.unwrap();
        assert_eq!(engine.assist_settings(DEVICE_SCOPE).await.unwrap()["serverAssist"], "uwu");

        // Now the server does it, with the mail sent along.
        let summary = engine.assist_summarize(json!({ "emailId": id }), None, None).await.unwrap();
        assert_eq!(
            (summary["summary"].as_str(), summary["emailId"].as_str()),
            (Some("Ein Fest im Park."), Some(id.as_str()))
        );
        let (_, sent) = calls.lock().unwrap().iter().find(|(m, _)| m == "Assist/summarize").cloned().unwrap();
        assert_eq!(sent["foreignMails"][0]["from"][0]["email"], "mia@example.com");
        assert_eq!(sent["foreignMails"][0]["subject"], "Sommerfest");
        assert!(sent.get("emailId").is_none() && sent["foreignMails"][0].get("headers").is_none());

        let label = engine.assist_create_label(DEVICE_SCOPE, json!({ "name": "Feiern" })).await.unwrap();
        engine.assist_create_label(DEVICE_SCOPE, json!({ "name": "Reisen" })).await.unwrap();
        let suggestion = engine.assist_suggest_labels(&id, Some("de"), None).await.unwrap();
        assert_eq!(suggestion["emailId"], id.as_str());
        assert_eq!(suggestion["verdicts"][0]["labelId"], label["id"]);
        assert_eq!(suggestion["verdicts"][0]["fits"], true);
        assert_eq!(suggestion["providerName"], "Mistral");
        let (_, sent) = calls.lock().unwrap().iter().rfind(|(m, _)| m == "AssistLabel/suggest").cloned().unwrap();
        assert_eq!(sent["foreignLabels"].as_array().unwrap().len(), 2);
        assert_eq!((sent["suggestNew"].as_bool(), sent["language"].as_str()), (Some(true), Some("de")));
        assert!(keywords(&engine, &id).is_empty(), "suggestions change nothing");

        let estimate = engine
            .assist_estimate("acc", "AssistLabel/suggest", json!({ "emailId": id, "suggestNew": false }), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(estimate["method"], "AssistLabel/suggest");
        let (_, sent) = calls.lock().unwrap().iter().rfind(|(m, _)| m == "Assist/estimate").cloned().unwrap();
        assert_eq!(sent["arguments"]["suggestNew"], false);
        assert_eq!(sent["arguments"]["foreignMails"].as_array().unwrap().len(), 1);
        assert_eq!(engine.assist_features("acc").await.unwrap().unwrap()["autoLabels"], true);

        // The model's part of auto-labels judges only the labels still missing, and is logged.
        engine.assist_update_settings(DEVICE_SCOPE, json!({ "autoLabels": true })).await.unwrap();
        engine.auto_label("acc", vec![id.clone()]).await;
        assert_eq!(keywords(&engine, &id), ["feiern"]);
        let (_, sent) = calls.lock().unwrap().iter().rfind(|(m, _)| m == "AssistLabel/suggest").cloned().unwrap();
        assert_eq!(sent["suggestNew"], false);
        let log = engine.assist_label_log(DEVICE_SCOPE, Some(vec![id.clone()]), None).await.unwrap();
        assert_eq!((log[0]["source"].as_str(), log[0]["providerName"].as_str()), (Some("ai"), Some("Mistral")));
        assert_eq!(engine.server_auto_labels_today().unwrap(), 1);
        assert_eq!(engine.device().requests_today(Feature::AutoLabels).unwrap(), 0, "no device provider asked");

        // Switched off again, the device answers.
        engine.assist_update_settings(DEVICE_SCOPE, json!({ "serverAssist": null })).await.unwrap();
        let before = foreign(&calls);
        let local = engine
            .assist_estimate("acc", "AssistLabel/suggest", json!({ "emailId": id }), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(local["providerName"], "Ollama");
        assert_eq!(local["outputTokens"], 2 * estimate::TYPICAL_VERDICT_TOKENS + estimate::TYPICAL_NEW_LABELS_TOKENS);
        assert_eq!(foreign(&calls), before);
    }

    #[tokio::test]
    async fn a_chosen_server_that_cannot_do_it_is_no_reason_to_ask_anyone_else() {
        // Chosen while it allowed foreign mail; now it doesn't.
        let (_dir, engine, id, calls) = engine_with_uwumail(false, server_answers).await;
        engine
            .device()
            .create_provider(
                &json!({ "kind": "ollama", "name": "Ollama", "baseUrl": "http://127.0.0.1:9", "model": "llama3" }),
            )
            .unwrap();
        engine.assist_create_label(DEVICE_SCOPE, json!({ "name": "Feiern" })).await.unwrap();
        engine.inner.store.set_assist_setting("serverAssist", Some("uwu")).unwrap();
        engine.assist_update_settings(DEVICE_SCOPE, json!({ "autoLabels": true })).await.unwrap();

        let refused =
            engine.assist_estimate("acc", "Assist/summarize", json!({ "emailId": id }), None).await.unwrap_err();
        assert_eq!(refused.assist_kind(), Some("assistUnavailable"), "not this device's Ollama");
        let refused = engine.assist_summarize(json!({ "emailId": id }), None, None).await.unwrap_err();
        assert_eq!(refused.assist_kind(), Some("assistUnavailable"));
        let refused = engine.assist_suggest_labels(&id, None, None).await.unwrap_err();
        assert_eq!(refused.assist_kind(), Some("assistUnavailable"));
        let refused = engine.assist_spam_check(&id, None).await.unwrap_err();
        assert_eq!(refused.assist_kind(), Some("assistUnavailable"));
        let refused = engine.assist_compose("acc", json!({ "mode": "write", "instruction": "Sag zu" }), None, None);
        assert_eq!(refused.await.unwrap_err().assist_kind(), Some("assistUnavailable"));
        assert_eq!(engine.assist_features("acc").await.unwrap(), None);
        let scopes = engine.assist_scopes().await.unwrap();
        let device = scopes.as_array().unwrap().iter().find(|s| s["id"] == DEVICE_SCOPE).unwrap().clone();
        assert!(device["options"]["features"].as_object().unwrap().values().all(|on| on == false));
        engine.auto_label("acc", vec![id.clone()]).await;
        assert!(keywords(&engine, &id).is_empty());
        for feature in Feature::ALL {
            assert_eq!(engine.device().requests_today(feature).unwrap(), 0, "no device provider asked");
        }
        assert!(calls.lock().unwrap().iter().all(|(_, args)| !args.to_string().contains("foreignMails")));

        // A chosen mailbox that is gone: nobody either.
        engine.inner.store.set_assist_setting("serverAssist", Some("removed")).unwrap();
        let refused =
            engine.assist_estimate("acc", "Assist/summarize", json!({ "emailId": id }), None).await.unwrap_err();
        assert_eq!(refused.assist_kind(), Some("assistUnavailable"));
        // Removing the chosen mailbox switches the choice off: this device's providers again.
        engine.inner.store.set_assist_setting("serverAssist", Some("uwu")).unwrap();
        engine.remove_account("uwu").await.unwrap();
        assert_eq!(engine.assist_settings(DEVICE_SCOPE).await.unwrap()["serverAssist"], Value::Null);
        let local =
            engine.assist_estimate("acc", "Assist/summarize", json!({ "emailId": id }), None).await.unwrap().unwrap();
        assert_eq!(local["providerName"], "Ollama");
    }

    #[tokio::test]
    async fn a_draft_takes_along_only_mail_whose_ai_is_this_devices() {
        use crate::model::{FolderRole, MessageFlags};
        use crate::store::FolderInfo;
        let (_dir, engine, id, _) = engine_with_uwumail(true, server_answers).await;
        let store = &engine.inner.store;
        let inbox = store
            .upsert_folder(
                "uwu",
                &FolderInfo {
                    path: "Inbox",
                    name: "Inbox",
                    role: Some(FolderRole::Inbox),
                    delimiter: Some("/"),
                    selectable: true,
                    parent_ref: None,
                },
            )
            .unwrap();
        let raw = "From: Leni <leni@example.com>\r\nTo: mini@uwu.test\r\nSubject: Geheim\r\n\
Message-ID: <geheim@example.com>\r\nContent-Type: text/plain\r\n\r\nNur fuer den Server.\r\n";
        let own = store
            .insert_message("uwu", &inbox, 1, MessageFlags::default(), 10, None, &crate::mime::parse(raw.as_bytes()))
            .unwrap()
            .unwrap();
        let other = engine.device_reply_mail(&json!({ "replyToEmailId": own }), false).await;
        assert!(other.is_none(), "a UwUMail account's mail stays with its server");
        let mine = engine.device_reply_mail(&json!({ "replyToEmailId": id }), false).await.unwrap();
        assert_eq!(mine.subject, "Sommerfest");

        // To the chosen server, only the compose fields and the mail it may have.
        let sent = engine
            .foreign_compose_arguments(
                &json!({ "mode": "write", "instruction": "Sag zu", "replyToEmailId": own, "accountId": "uwu",
                         "foreignMails": [{ "text": "untergeschoben" }], "extra": 1 }),
                false,
            )
            .await;
        assert_eq!(sent, json!({ "mode": "write", "instruction": "Sag zu" }));
    }

    #[tokio::test]
    async fn a_server_that_does_not_allow_foreign_mail_cannot_be_chosen() {
        let (_dir, engine, _, calls) = engine_with_uwumail(false, server_answers).await;
        let refused = engine.assist_update_settings(DEVICE_SCOPE, json!({ "serverAssist": "uwu" })).await.unwrap_err();
        assert_eq!(refused.assist_kind(), Some("invalidProperties"));
        let scopes = engine.assist_scopes().await.unwrap();
        let device = scopes.as_array().unwrap().iter().find(|s| s["id"] == DEVICE_SCOPE).unwrap().clone();
        assert_eq!(device["options"]["foreignServers"], json!([]));
        assert!(calls.lock().unwrap().iter().all(|(_, args)| !args.to_string().contains("foreignMails")));
    }
}
