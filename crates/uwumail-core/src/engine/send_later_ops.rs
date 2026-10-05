//! "Send later" and the outbox that sends it (see `send_later` for the why).
//!
//! One task looks after the whole outbox, for the "undo send" window and for mail sent later:
//! it takes out what is due by the wall clock, sends it, and sleeps until the next one is due but
//! never longer than [`send_later::MAX_NAP`], so a time that passed while the computer slept is
//! noticed soon after waking. What was due while UwUMail was closed goes on the next start.
//!
//! Drafts: scheduling removes the mail's draft from the server's Drafts folder, as sending does,
//! so there is one copy and it can't go twice from another device. Stopping a scheduled mail
//! puts it into Drafts again; editing opens it in the composer, which saves it as a draft at once.
//! A local one that can't be sent when its time comes is tried again a few times while its
//! server can't be reached, then kept as a draft like any mail that couldn't go.

use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Notify;

use super::*;
use crate::jmap_scheduled;
use crate::send_later::{
    self, ScheduledKind, ScheduledReceipt, ScheduledRef, ScheduledSend, SendLaterInfo, check_time, format_time,
    parse_time,
};
use crate::store::TakenSend;

/// The outbox task: whether it runs, and how to wake it when something new is due earlier.
#[derive(Default)]
pub(super) struct OutboxState {
    running: AtomicBool,
    wake: Notify,
}

impl Engine {
    /// Starts the outbox task once; later calls only wake it to look again.
    pub(super) fn run_outbox(&self) {
        let state = &self.inner.send_later;
        if state.running.swap(true, Ordering::SeqCst) {
            state.wake.notify_one();
            return;
        }
        let engine = self.clone();
        self.inner.runtime.spawn(async move {
            loop {
                for taken in engine.take_due(now_millis()) {
                    let engine = engine.clone();
                    tokio::spawn(async move { engine.deliver(taken).await });
                }
                let next = engine.inner.store.next_outbox_at().unwrap_or_else(|error| {
                    tracing::warn!("Couldn't read the outbox: {error}");
                    None
                });
                let nap = send_later::nap(next, now_millis());
                tokio::select! {
                    () = tokio::time::sleep(nap) => {}
                    () = engine.inner.send_later.wake.notified() => {}
                }
            }
        });
    }

    /// Takes out what is due at `now`; each entry only once.
    pub(super) fn take_due(&self, now: i64) -> Vec<TakenSend> {
        self.inner.store.take_due_outbox(now).unwrap_or_else(|error| {
            tracing::warn!("Couldn't read the outbox: {error}");
            Vec::new()
        })
    }

    async fn deliver(&self, taken: TakenSend) {
        let TakenSend { id, account_id, message_json, later, attempts } = taken;
        let message: OutgoingMessage = match serde_json::from_str(&message_json) {
            Ok(message) => message,
            Err(error) => {
                tracing::warn!("A queued message couldn't be read: {error}");
                return;
            }
        };
        let result = self.send(message.clone()).await;
        if later {
            self.inner.emit(EngineEvent::ScheduledChanged {});
        }
        match result {
            Ok(()) => self.inner.emit(EngineEvent::SendDone { send_id: id, account_id }),
            Err(error) => {
                // Not reachable right now (e.g. just woken up): later mail tries again for a while.
                if later
                    && error.code == ErrorCode::ConnectionFailed
                    && let Some(at) = send_later::retry_at(attempts, now_millis())
                    && self.inner.store.insert_later_outbox(&id, &account_id, &message_json, at, attempts + 1).is_ok()
                {
                    tracing::info!("A scheduled mail couldn't go yet, trying again: {error}");
                    self.inner.emit(EngineEvent::ScheduledChanged {});
                    self.run_outbox();
                    return;
                }
                // Nothing written gets lost: it waits in Drafts.
                if let Err(draft_error) = self.save_draft(message.clone()).await {
                    tracing::warn!("Couldn't keep the unsent message as a draft: {draft_error}");
                }
                self.inner.emit(EngineEvent::SendFailed {
                    send_id: id,
                    account_id,
                    reason: error.message,
                    message: Box::new(message),
                });
            }
        }
    }

    /// The JMAP connection of a mailbox whose UwUMail server holds mail for later.
    async fn holding_server(&self, account: &AccountRecord) -> Option<Arc<JmapClient>> {
        if account.protocol != Protocol::Jmap {
            return None;
        }
        match self.inner.jmap_client(&account.id).await {
            Ok(client) => jmap_scheduled::holds_mail(&client).then_some(client),
            Err(error) => {
                tracing::info!("Send later of {} uses this device: {error}", account.id);
                None
            }
        }
    }

    /// Where a mailbox's mail sent later waits, and how far ahead it may be.
    pub async fn send_later_info(&self, account_id: &str) -> Result<SendLaterInfo> {
        let account = self.inner.store.account(account_id)?;
        Ok(match self.holding_server(&account).await {
            Some(client) => {
                SendLaterInfo { kind: ScheduledKind::Server, max_delay_seconds: client.session.max_delayed_send }
            }
            None => SendLaterInfo { kind: ScheduledKind::Local, max_delay_seconds: send_later::LOCAL_MAX_DELAY_SECS },
        })
    }

    /// Sends the mail at `send_at` (RFC 3339): held by the UwUMail server, or in this device's
    /// outbox for every other mailbox.
    pub async fn send_later(&self, outgoing: OutgoingMessage, send_at: &str) -> Result<ScheduledReceipt> {
        let at = parse_time(send_at)?;
        let account = self.inner.store.account(&outgoing.account_id)?;
        let recipients: Vec<Address> = outgoing.to.iter().chain(&outgoing.cc).chain(&outgoing.bcc).cloned().collect();
        if recipients.is_empty() {
            return Err(Error::invalid("There is nobody to send this to."));
        }
        let from = self.sender_for(&account, outgoing.from_email.as_deref())?;
        let threading = self.threading_for(outgoing.in_reply_to.as_deref())?;
        // Mistakes like a broken address show now, not when its time comes.
        let message = smtp::build(&smtp::Mail {
            from: &from,
            to: &outgoing.to,
            cc: &outgoing.cc,
            bcc: &outgoing.bcc,
            subject: &outgoing.subject,
            text: &outgoing.text,
            html: &outgoing.html,
            threading: threading.as_ref(),
            attachments: &outgoing.attachments,
            message_id: None,
            draft: false,
        })?;

        let receipt = if let Some(client) = self.holding_server(&account).await {
            check_time(at, now_millis(), client.session.max_delayed_send)?;
            let envelope: Vec<String> = recipients.iter().map(|a| a.email.clone()).collect();
            let (id, taken_at) = jmap_scheduled::submit(
                &client,
                &self.inner.store,
                &account.id,
                message.formatted(),
                &from.email,
                &envelope,
                &format_time(at),
            )
            .await?;
            self.inner.wake(&account.id);
            ScheduledReceipt { id, kind: ScheduledKind::Server, send_at: taken_at }
        } else {
            check_time(at, now_millis(), send_later::LOCAL_MAX_DELAY_SECS)?;
            if self.inner.store.later_outbox_count()? >= send_later::MAX_LOCAL_SCHEDULED {
                return Err(Error::invalid("Too many mails are scheduled already."));
            }
            let id = uuid::Uuid::new_v4().to_string();
            self.inner.store.insert_later_outbox(&id, &account.id, &serde_json::to_string(&outgoing)?, at, 0)?;
            self.run_outbox();
            ScheduledReceipt { id, kind: ScheduledKind::Local, send_at: format_time(at) }
        };

        // One copy only: the draft goes, as when sending; stopping brings it back. In the
        // background, so a slow or unreachable server doesn't hold up the composer.
        if let Some(key) = outgoing.draft_key.clone() {
            let engine = self.clone();
            let account_id = account.id.clone();
            self.inner.runtime.spawn(async move {
                if let Err(error) = engine.delete_draft(&account_id, &key).await {
                    tracing::info!("The draft of a scheduled mail stays for now: {error}");
                }
            });
        }
        self.inner.store.remember_contacts(&recipients)?;
        self.inner.emit(EngineEvent::ScheduledChanged {});
        Ok(receipt)
    }

    /// Mail waiting for its time: this device's outbox and what UwUMail servers hold, soonest
    /// first. A server that can't be reached is left out.
    pub async fn scheduled_sends(&self) -> Result<Vec<ScheduledSend>> {
        let mut all: Vec<(i64, ScheduledSend)> = Vec::new();
        for entry in self.inner.store.later_outbox()? {
            let Ok(message) = serde_json::from_str::<OutgoingMessage>(&entry.message_json) else { continue };
            all.push((
                entry.send_at,
                ScheduledSend {
                    id: entry.id,
                    account_id: entry.account_id,
                    kind: ScheduledKind::Local,
                    send_at: format_time(entry.send_at),
                    subject: message.subject,
                    to: if message.to.is_empty() { message.cc } else { message.to },
                    retrying: entry.attempts > 0,
                },
            ));
        }
        let now = now_millis();
        for account in self.inner.store.accounts()? {
            let Some(client) = self.holding_server(&account).await else { continue };
            match jmap_scheduled::pending(&client).await {
                Ok((submissions, emails)) => {
                    for entry in jmap_scheduled::scheduled_from(&account.id, &submissions, &emails, now) {
                        all.push((parse_time(&entry.send_at).unwrap_or(0), entry));
                    }
                }
                Err(error) => tracing::info!("No scheduled mail of {}: {error}", account.id),
            }
        }
        all.sort_by_key(|(at, _)| *at);
        Ok(all.into_iter().map(|(_, entry)| entry).collect())
    }

    async fn server_for(&self, reference: &ScheduledRef) -> Result<Arc<JmapClient>> {
        let account = self.inner.store.account(&reference.account_id)?;
        self.holding_server(&account)
            .await
            .ok_or_else(|| Error::new(ErrorCode::ConnectionFailed, "The mail server can't be reached right now."))
    }

    /// Gives a scheduled mail a new time.
    pub async fn reschedule_send(&self, reference: &ScheduledRef, send_at: &str) -> Result<()> {
        reference.check()?;
        let at = parse_time(send_at)?;
        match reference.kind {
            ScheduledKind::Local => {
                check_time(at, now_millis(), send_later::LOCAL_MAX_DELAY_SECS)?;
                if !self.inner.store.reschedule_later_outbox(&reference.id, &reference.account_id, at)? {
                    return Err(Error::not_found("This mail is already on its way."));
                }
                self.run_outbox();
            }
            ScheduledKind::Server => {
                let client = self.server_for(reference).await?;
                check_time(at, now_millis(), client.session.max_delayed_send)?;
                jmap_scheduled::resubmit(
                    &client,
                    &self.inner.store,
                    &reference.account_id,
                    &reference.id,
                    &format_time(at),
                )
                .await?;
            }
        }
        self.inner.emit(EngineEvent::ScheduledChanged {});
        Ok(())
    }

    /// Sends a scheduled mail right away.
    pub async fn send_scheduled_now(&self, reference: &ScheduledRef) -> Result<()> {
        reference.check()?;
        match reference.kind {
            ScheduledKind::Local => {
                if !self.inner.store.reschedule_later_outbox(&reference.id, &reference.account_id, now_millis())? {
                    return Err(Error::not_found("This mail is already on its way."));
                }
                self.run_outbox();
            }
            ScheduledKind::Server => {
                let client = self.server_for(reference).await?;
                jmap_scheduled::resubmit(
                    &client,
                    &self.inner.store,
                    &reference.account_id,
                    &reference.id,
                    &format_time(now_millis()),
                )
                .await?;
                self.inner.wake(&reference.account_id);
            }
        }
        self.inner.emit(EngineEvent::ScheduledChanged {});
        Ok(())
    }

    /// Stops a scheduled mail without opening it: it is a draft in Drafts again.
    pub async fn stop_scheduled(&self, reference: &ScheduledRef) -> Result<()> {
        reference.check()?;
        match reference.kind {
            ScheduledKind::Local => {
                let gone = || Error::not_found("This mail is already on its way.");
                let entry = self
                    .inner
                    .store
                    .later_outbox()?
                    .into_iter()
                    .find(|entry| entry.id == reference.id && entry.account_id == reference.account_id)
                    .ok_or_else(gone)?;
                let message: OutgoingMessage = serde_json::from_str(&entry.message_json)?;
                // Held back while Drafts is written, so it can't go meanwhile; and it stays
                // scheduled as it was when Drafts can't be reached.
                let far = now_millis() + i64::try_from(send_later::LOCAL_MAX_DELAY_SECS).unwrap_or(0) * 1000;
                if !self.inner.store.reschedule_later_outbox(&entry.id, &entry.account_id, far)? {
                    return Err(gone());
                }
                if let Err(error) = self.save_draft(message).await {
                    self.inner.store.reschedule_later_outbox(&entry.id, &entry.account_id, entry.send_at)?;
                    self.run_outbox();
                    return Err(error);
                }
                self.inner.store.take_later_outbox(&entry.id, &entry.account_id)?;
            }
            ScheduledKind::Server => {
                let client = self.server_for(reference).await?;
                let email_id = jmap_scheduled::cancel(&client, &reference.id).await?;
                jmap_scheduled::to_drafts(&client, &self.inner.store, &reference.account_id, &email_id).await?;
                self.inner.wake(&reference.account_id);
                self.inner.emit(EngineEvent::MailChanged { account_id: reference.account_id.clone() });
            }
        }
        self.inner.emit(EngineEvent::ScheduledChanged {});
        Ok(())
    }

    /// Stops a scheduled mail and hands it over for the composer, which saves it as a draft.
    pub async fn edit_scheduled(&self, reference: &ScheduledRef) -> Result<OutgoingMessage> {
        reference.check()?;
        let message = match reference.kind {
            ScheduledKind::Local => self.take_local(reference)?,
            ScheduledKind::Server => {
                let client = self.server_for(reference).await?;
                let email_id = jmap_scheduled::cancel(&client, &reference.id).await?;
                match self.held_message(&client, &reference.account_id, &email_id).await {
                    Ok(message) => {
                        // The composer saves it as a draft of its own; this copy would be a second one.
                        let _ = jmap_sync::destroy_emails(&client, &[email_id]).await;
                        message
                    }
                    Err(error) => {
                        // Not lost: it is in Drafts to open from there.
                        let _ = jmap_scheduled::to_drafts(&client, &self.inner.store, &reference.account_id, &email_id)
                            .await;
                        return Err(error);
                    }
                }
            }
        };
        if reference.kind == ScheduledKind::Server {
            self.inner.wake(&reference.account_id);
            self.inner.emit(EngineEvent::MailChanged { account_id: reference.account_id.clone() });
        }
        self.inner.emit(EngineEvent::ScheduledChanged {});
        Ok(message)
    }

    fn take_local(&self, reference: &ScheduledRef) -> Result<OutgoingMessage> {
        let json = self
            .inner
            .store
            .take_later_outbox(&reference.id, &reference.account_id)?
            .ok_or_else(|| Error::not_found("This mail is already on its way."))?;
        Ok(serde_json::from_str(&json)?)
    }

    /// A mail the server held, read back for the composer. Bcc isn't in the mail itself: it is
    /// whoever else the submission went to.
    async fn held_message(&self, client: &JmapClient, account_id: &str, email_id: &str) -> Result<OutgoingMessage> {
        let raw = jmap_scheduled::download(client, email_id).await?;
        Ok(self.message_from_raw(account_id, &raw))
    }

    fn message_from_raw(&self, account_id: &str, raw: &[u8]) -> OutgoingMessage {
        let parsed = mime::parse(raw);
        let parts = mime::draft_parts(raw);
        let in_reply_to = parsed
            .in_reply_to
            .as_ref()
            .and_then(|parent| self.inner.store.message_by_header_id(account_id, parent).ok().flatten());
        let html =
            parsed.html.clone().unwrap_or_else(|| mime::text_to_html(parsed.text.as_deref().unwrap_or_default()));
        OutgoingMessage {
            account_id: account_id.to_string(),
            from_email: parsed.from.as_ref().map(|from| from.email.clone()),
            to: parsed.to,
            cc: parsed.cc,
            bcc: parts.bcc,
            subject: parsed.subject,
            text: parsed.text.unwrap_or_default(),
            html,
            in_reply_to,
            attachments: parts.attachments,
            draft_key: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::send_later::MIN_AHEAD_MS;

    fn engine() -> (tempfile::TempDir, Engine) {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::new(EngineOptions {
            data_dir: dir.path().to_path_buf(),
            secrets: Arc::new(crate::secrets::MemorySecrets::default()),
            open_url: Arc::new(|_| {}),
            recognizer: None,
        })
        .unwrap();
        engine.inner.background_sync.store(false, Ordering::Relaxed);
        engine
            .inner
            .store
            .insert_account(&AccountRecord {
                id: "acc".into(),
                name: "Test".into(),
                email: "mini@uwumail.example".into(),
                display_name: "Mini".into(),
                color: AccountColor::Pink,
                auth: AuthKind::Password,
                username: "mini@uwumail.example".into(),
                // Nothing may be reached: these tests never send.
                imap: ServerSettings { host: "imap.uwumail.invalid".into(), port: 993, security: Security::Tls },
                smtp: ServerSettings { host: "smtp.uwumail.invalid".into(), port: 465, security: Security::Tls },
                protocol: Protocol::Imap,
                jmap_url: None,
            })
            .unwrap();
        (dir, engine)
    }

    fn message(subject: &str) -> OutgoingMessage {
        OutgoingMessage {
            account_id: "acc".into(),
            to: vec![Address { name: Some("Kim".into()), email: "kim@uwumail.example".into() }],
            cc: vec![],
            bcc: vec![],
            subject: subject.into(),
            html: "<p>Hi</p>".into(),
            text: "Hi".into(),
            in_reply_to: None,
            attachments: vec![],
            draft_key: None,
            from_email: None,
        }
    }

    fn local(id: &str) -> ScheduledRef {
        ScheduledRef { id: id.into(), account_id: "acc".into(), kind: ScheduledKind::Local }
    }

    #[tokio::test]
    async fn an_imap_mailbox_schedules_on_this_device() {
        let (_dir, engine) = engine();
        let info = engine.send_later_info("acc").await.unwrap();
        assert_eq!(info.kind, ScheduledKind::Local);
        assert_eq!(info.max_delay_seconds, send_later::LOCAL_MAX_DELAY_SECS);

        let at = (now_millis() / 1000 + 3600) * 1000;
        let receipt = engine.send_later(message("Angebot"), &format_time(at)).await.unwrap();
        assert_eq!(receipt.kind, ScheduledKind::Local);
        assert_eq!(receipt.send_at, format_time(at));

        let list = engine.scheduled_sends().await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].subject, "Angebot");
        assert_eq!(list[0].to[0].email, "kim@uwumail.example");
        assert!(!list[0].retrying);

        // The outbox takes it at its time and not a moment before (made-up clock).
        assert!(engine.take_due(at - 1).is_empty());
        let due = engine.take_due(at);
        assert_eq!(due.len(), 1);
        assert!(due[0].later);
        assert!(engine.scheduled_sends().await.unwrap().is_empty(), "taken out to be sent");
    }

    #[tokio::test]
    async fn times_too_soon_too_far_or_broken_are_refused() {
        let (_dir, engine) = engine();
        let soon = format_time(now_millis() + MIN_AHEAD_MS / 2);
        assert!(engine.send_later(message("x"), &soon).await.is_err());
        let far = format_time(now_millis() + (send_later::LOCAL_MAX_DELAY_SECS as i64 + 86_400) * 1000);
        assert!(engine.send_later(message("x"), &far).await.is_err());
        assert!(engine.send_later(message("x"), "tomorrow").await.is_err());
        let nobody = OutgoingMessage { to: vec![], ..message("x") };
        assert!(engine.send_later(nobody, &format_time(now_millis() + 3_600_000)).await.is_err());
        let broken = OutgoingMessage { to: vec![Address { name: None, email: "nope".into() }], ..message("x") };
        assert!(engine.send_later(broken, &format_time(now_millis() + 3_600_000)).await.is_err());
        assert!(engine.scheduled_sends().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_new_time_send_now_and_edit_work_on_the_local_outbox() {
        let (_dir, engine) = engine();
        let at = (now_millis() / 1000 + 3600) * 1000;
        let first = engine.send_later(message("Eins"), &format_time(at)).await.unwrap();
        let second = engine.send_later(message("Zwei"), &format_time(at + 60_000)).await.unwrap();

        // Tomorrow instead.
        let tomorrow = at + 86_400_000;
        engine.reschedule_send(&local(&first.id), &format_time(tomorrow)).await.unwrap();
        let list = engine.scheduled_sends().await.unwrap();
        assert_eq!(list.iter().map(|s| s.subject.as_str()).collect::<Vec<_>>(), ["Zwei", "Eins"]);
        assert!(engine.reschedule_send(&local(&first.id), &format_time(now_millis())).await.is_err(), "not the past");

        // Send now: due at once, nothing else is.
        engine.send_scheduled_now(&local(&second.id)).await.unwrap();
        let due = engine.take_due(now_millis());
        assert_eq!(due.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), [second.id.as_str()]);
        assert!(engine.send_scheduled_now(&local(&second.id)).await.is_err(), "already on its way");

        // Edit: it comes back for the composer and is gone from the outbox.
        let back = engine.edit_scheduled(&local(&first.id)).await.unwrap();
        assert_eq!(back.subject, "Eins");
        assert!(engine.scheduled_sends().await.unwrap().is_empty());
        assert!(engine.edit_scheduled(&local(&first.id)).await.is_err());
        assert!(engine.take_due(tomorrow + 1).is_empty(), "never sent after all");

        let other_account = ScheduledRef { account_id: "other".into(), ..local(&second.id) };
        assert!(engine.stop_scheduled(&other_account).await.is_err());
        assert!(engine.stop_scheduled(&local("../etc")).await.is_err());
    }

    #[test]
    fn a_held_mail_comes_back_with_its_parts() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _guard = rt.enter();
        let (_dir, engine) = engine();
        let raw = b"From: Mini <mini@uwumail.example>\r\nTo: Kim <kim@uwumail.example>\r\nCc: lu@uwumail.example\r\nSubject: Angebot\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHallo Kim\r\n";
        let message = engine.message_from_raw("acc", raw);
        assert_eq!(message.subject, "Angebot");
        assert_eq!(message.from_email.as_deref(), Some("mini@uwumail.example"));
        assert_eq!(message.to[0].email, "kim@uwumail.example");
        assert_eq!(message.cc[0].email, "lu@uwumail.example");
        assert!(message.html.contains("Hallo Kim"));
        assert_eq!(message.draft_key, None, "the composer saves a draft of its own");
    }
}
