//! Contacts across all accounts, behind one set of calls: JMAP Contacts where the UwUMail server
//! has them, CardDAV for other password accounts, nothing for Microsoft and Google sign-ins
//! (their contacts need other APIs).

use chrono::Utc;
use serde_json::{Map, Value, json};
use url::Url;

use super::calendar_ops::password_hosts;
use super::*;
use crate::calendar::{dav, jscal};
use crate::contacts::{self, BookEntry, RemoteCard, Source, SourceState, carddav, jmap_contacts, vcard};

/// How long an account's address books and cards are used before they're asked for again.
const LIST_FRESH: Duration = Duration::from_secs(5 * 60);
/// How long "no address book here" holds before discovery runs again.
const RETRY_UNAVAILABLE: Duration = Duration::from_secs(10 * 60);
/// How long recipient suggestions wait for an account's contacts before going on without them.
const SUGGESTION_WAIT: Duration = Duration::from_secs(2);
/// Suggestions shown at most.
const SUGGESTIONS: usize = 8;
/// The biggest card written, as the UwUMail server allows.
const MAX_CARD_BYTES: usize = 1024 * 1024;
/// Properties a change may not touch.
const IMMUTABLE: &[&str] = &["id", "uid", "@type"];

fn now_utc_text() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn check_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 200 || name.chars().any(char::is_control) {
        return Err(Error::invalid("Give the address book a name of up to 200 characters."));
    }
    Ok(name)
}

/// The name a card goes by: its full name, its name's parts, its company.
fn card_name(card: &Value) -> Option<String> {
    let name = card.get("name");
    if let Some(full) = name.and_then(|n| n.get("full")).and_then(Value::as_str).map(str::trim)
        && !full.is_empty()
    {
        return Some(full.to_string());
    }
    let parts: Vec<&str> = name
        .and_then(|n| n.get("components"))
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter(|part| part.get("kind").and_then(Value::as_str) != Some("separator"))
                .filter_map(|part| part.get("value").and_then(Value::as_str))
                .filter(|value| !value.trim().is_empty())
                .collect()
        })
        .unwrap_or_default();
    if !parts.is_empty() {
        return Some(parts.join(" "));
    }
    card.get("organizations")
        .and_then(Value::as_object)
        .and_then(|orgs| orgs.values().find_map(|org| org.get("name").and_then(Value::as_str)))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(String::from)
}

/// The addresses of cards that match a query, as recipient suggestions.
fn suggestions_from(cards: &[RemoteCard], query: &str) -> Vec<Contact> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Vec::new();
    }
    let mut found = Vec::new();
    for remote in cards {
        let card = Value::Object(remote.card.clone());
        let name = card_name(&card);
        let emails: Vec<&str> = card
            .get("emails")
            .and_then(Value::as_object)
            .map(|emails| emails.values().filter_map(|e| e.get("address").and_then(Value::as_str)).collect())
            .unwrap_or_default();
        let name_matches = name.as_deref().is_some_and(|name| name.to_lowercase().contains(&query));
        for email in emails {
            if name_matches || email.to_lowercase().contains(&query) {
                found.push(Contact {
                    name: name.clone().filter(|name| name != email),
                    email: email.to_string(),
                    last_used: None,
                    times_contacted: 0,
                });
            }
        }
    }
    found
}

/// A card for writing: a JSON object without the app's ids.
fn card_object(card: Value) -> Result<Map<String, Value>> {
    let Value::Object(mut card) = card else {
        return Err(Error::invalid("A contact has to be a JSContact card."));
    };
    card.remove("id");
    card.remove("addressBookIds");
    Ok(card)
}

/// A CardDAV card read to be changed and written back.
struct DavCard {
    url: Url,
    etag: Option<String>,
    card: Map<String, Value>,
}

async fn read_dav_card(client: &dav::DavClient, home: &Url, path: &str) -> Result<DavCard> {
    let url = contacts::dav_url(home, path)?;
    let object = carddav::get_card(client, &url).await?;
    let card = vcard::from_vcard(&object.data)
        .ok_or_else(|| Error::invalid("This contact isn't a vCard UwUMail can read."))?;
    Ok(DavCard { url, etag: object.etag, card })
}

fn vcard_text(card: &Map<String, Value>) -> Result<String> {
    let text = vcard::to_vcard(card)?;
    if text.len() > MAX_CARD_BYTES {
        return Err(Error::invalid("This contact is too big; a smaller photo will do."));
    }
    Ok(text)
}

impl Inner {
    /// Where an account's contacts live, found once and remembered.
    async fn contacts_source(&self, account_id: &str) -> Result<Source> {
        {
            let sources = self.contacts_sources.lock().await;
            match sources.get(account_id) {
                Some(SourceState::Ready(source)) => return Ok(source.clone()),
                Some(SourceState::Unavailable { problem, since }) if since.elapsed() < RETRY_UNAVAILABLE => {
                    return Err(problem.clone());
                }
                _ => {}
            }
        }
        let account = self.store.account(account_id)?;
        match self.find_contacts_source(&account).await {
            Ok(source) => {
                self.contacts_sources.lock().await.insert(account_id.to_string(), SourceState::Ready(source.clone()));
                Ok(source)
            }
            Err(problem) => {
                // Only a definite "none here" is remembered; a network hiccup is asked again next time.
                if problem.code == ErrorCode::NotSupported {
                    self.contacts_sources.lock().await.insert(
                        account_id.to_string(),
                        SourceState::Unavailable { problem: problem.clone(), since: Instant::now() },
                    );
                }
                Err(problem)
            }
        }
    }

    async fn find_contacts_source(&self, account: &AccountRecord) -> Result<Source> {
        if account.protocol == Protocol::Jmap {
            let client = self.jmap_client(&account.id).await?;
            if client.session.contacts_account_id.is_some() {
                return Ok(Source::Jmap);
            }
        }
        let Secret::Password { password } = self.secrets.get(&account.id)? else {
            return Err(Error::not_supported(
                "Address books aren't available for mailboxes signed in with Microsoft or Google.",
            ));
        };
        let (_, domain) = autoconfig::split_email(&account.email)?;
        let manual = match self.store.carddav_url(&account.id)? {
            Some(url) => {
                Some(Url::parse(&url).map_err(|_| Error::invalid("The CardDAV address isn't a web address."))?)
            }
            None => None,
        };
        let trusted = password_hosts(account, manual.as_ref());
        let trusted: Vec<&str> = trusted.iter().map(String::as_str).collect();
        let client = dav::DavClient::new(&account.username, &password, &trusted)?.serving(carddav::WHAT);
        let hosts: Vec<String> =
            [&account.imap.host].into_iter().filter(|host| !host.trim().is_empty()).cloned().collect();
        let home = dav::discover_for(&client, manual.as_ref(), &domain, &hosts, &dav::CARDDAV_SERVICE).await?;
        Ok(Source::Dav { client: Arc::new(client), home })
    }

    pub(super) fn forget_contacts(&self, account_id: &str) {
        self.address_book_lists.lock().unwrap().remove(account_id);
        self.contact_card_lists.lock().unwrap().remove(account_id);
    }

    fn contacts_changed(&self, account_id: &str) {
        self.forget_contacts(account_id);
        self.emit(EngineEvent::ContactsChanged {});
    }

    /// An account's address books, from memory while fresh.
    async fn address_book_entries(&self, account_id: &str) -> Result<Vec<BookEntry>> {
        if let Some((at, entries)) = self.address_book_lists.lock().unwrap().get(account_id)
            && at.elapsed() < LIST_FRESH
        {
            return Ok(entries.clone());
        }
        let entries = match self.contacts_source(account_id).await? {
            Source::Jmap => {
                let client = self.jmap_client(account_id).await?;
                jmap_contacts::books(&client)
                    .await?
                    .into_iter()
                    .map(|book| BookEntry {
                        info: AddressBookInfo {
                            id: contacts::app_id(account_id, &book.id),
                            account_id: account_id.to_string(),
                            name: book.name,
                            is_default: book.is_default,
                            sort_order: book.sort_order,
                            may_write: book.may_write,
                            may_delete: book.may_delete,
                        },
                        remote: book.id,
                    })
                    .collect::<Vec<_>>()
            }
            Source::Dav { client, home } => {
                let chosen = self.store.default_address_book(account_id)?;
                let home_origin = home.origin();
                let mut entries: Vec<BookEntry> = carddav::books(&client, &home)
                    .await?
                    .into_iter()
                    .filter(|book| book.url.origin() == home_origin)
                    .enumerate()
                    .map(|(index, book)| {
                        let path = book.url.path().to_string();
                        let id = contacts::app_id(account_id, &path);
                        BookEntry {
                            info: AddressBookInfo {
                                is_default: chosen.as_deref() == Some(id.as_str()),
                                id,
                                account_id: account_id.to_string(),
                                name: book.name,
                                sort_order: index as i64,
                                may_write: book.writable,
                                may_delete: book.writable,
                            },
                            remote: path,
                        }
                    })
                    .collect();
                // Without a choice made here, the first address book that takes contacts is the default.
                if !entries.iter().any(|entry| entry.info.is_default)
                    && let Some(first) = entries.iter_mut().find(|entry| entry.info.may_write)
                {
                    first.info.is_default = true;
                }
                entries
            }
        };
        self.address_book_lists.lock().unwrap().insert(account_id.to_string(), (Instant::now(), entries.clone()));
        Ok(entries)
    }

    async fn book_entry(&self, book_id: &str) -> Result<(Source, BookEntry)> {
        let (account_id, _) = contacts::split_id(book_id)?;
        let source = self.contacts_source(account_id).await?;
        let mut entry = self.address_book_entries(account_id).await?.into_iter().find(|entry| entry.info.id == book_id);
        if entry.is_none() {
            self.forget_contacts(account_id);
            entry = self.address_book_entries(account_id).await?.into_iter().find(|entry| entry.info.id == book_id);
        }
        let entry = entry.ok_or_else(|| Error::not_found("This address book no longer exists."))?;
        Ok((source, entry))
    }

    /// An account's cards, from memory while fresh.
    async fn remote_cards(&self, account_id: &str) -> Result<Vec<RemoteCard>> {
        if let Some((at, cards)) = self.contact_card_lists.lock().unwrap().get(account_id)
            && at.elapsed() < LIST_FRESH
        {
            return Ok(cards.clone());
        }
        let cards = match self.contacts_source(account_id).await? {
            Source::Jmap => jmap_contacts::cards(&*self.jmap_client(account_id).await?).await?,
            Source::Dav { client, home } => {
                let entries = self.address_book_entries(account_id).await?;
                let reads = entries.iter().map(|entry| {
                    let client = Arc::clone(&client);
                    let home = home.clone();
                    async move {
                        let url = contacts::dav_url(&home, &entry.remote)?;
                        Ok::<_, Error>((entry, carddav::cards(&client, &url).await?))
                    }
                });
                let mut found = Vec::new();
                for read in futures::future::join_all(reads).await {
                    let (entry, objects) = match read {
                        Ok(read) => read,
                        Err(error) => {
                            tracing::warn!("An address book of {account_id} couldn't be read: {error}");
                            continue;
                        }
                    };
                    found.extend(objects.into_iter().filter_map(|object| {
                        Some(RemoteCard {
                            card: vcard::from_vcard(&object.data)?,
                            remote: object.url.path().to_string(),
                            book_remote: entry.remote.clone(),
                        })
                    }));
                }
                found
            }
        };
        self.contact_card_lists.lock().unwrap().insert(account_id.to_string(), (Instant::now(), cards.clone()));
        Ok(cards)
    }
}

impl Engine {
    /// For each account: whether it has address books, from where, and why not.
    pub async fn contacts_accounts(&self) -> Result<Vec<ContactsAccount>> {
        let accounts = self.inner.store.accounts()?;
        let sources = accounts.iter().map(|account| self.inner.contacts_source(&account.id));
        let mut found = Vec::new();
        for (account, source) in accounts.iter().zip(futures::future::join_all(sources).await) {
            let (source, problem) = match source {
                Ok(Source::Jmap) => (Some(ContactsSource::Jmap), None),
                Ok(Source::Dav { .. }) => (Some(ContactsSource::Carddav), None),
                Err(error) => (None, Some(error.message)),
            };
            found.push(ContactsAccount {
                account_id: account.id.clone(),
                source,
                carddav_url: self.inner.store.carddav_url(&account.id)?,
                problem,
            });
        }
        Ok(found)
    }

    /// Uses a CardDAV address typed in by hand for an account (`None` goes back to discovery).
    pub async fn set_carddav_url(&self, account_id: &str, url: Option<&str>) -> Result<()> {
        self.inner.store.account(account_id)?;
        let url = url.map(str::trim).filter(|url| !url.is_empty());
        if let Some(url) = url {
            let parsed = Url::parse(url).map_err(|_| Error::invalid("That isn't a web address."))?;
            if parsed.scheme() != "https" || parsed.host_str().is_none() {
                return Err(Error::invalid("The CardDAV address must start with https://."));
            }
        }
        self.inner.store.set_carddav_url(account_id, url)?;
        self.inner.contacts_sources.lock().await.remove(account_id);
        self.inner.contacts_changed(account_id);
        Ok(())
    }

    /// Every address book of every account that has some. Accounts that can't be reached are left out.
    pub async fn address_books(&self) -> Result<Vec<AddressBookInfo>> {
        let accounts = self.inner.store.accounts()?;
        let lists = accounts.iter().map(|account| self.inner.address_book_entries(&account.id));
        let mut books = Vec::new();
        for (account, list) in accounts.iter().zip(futures::future::join_all(lists).await) {
            match list {
                Ok(entries) => {
                    let mut infos: Vec<AddressBookInfo> = entries.into_iter().map(|entry| entry.info).collect();
                    infos.sort_by(|a, b| a.sort_order.cmp(&b.sort_order).then_with(|| a.name.cmp(&b.name)));
                    books.extend(infos);
                }
                Err(error) => tracing::debug!("No address books for {}: {error}", account.id),
            }
        }
        Ok(books)
    }

    /// A new address book, in the given account or the first one that has address books.
    pub async fn create_address_book(&self, account_id: Option<String>, name: &str) -> Result<AddressBookInfo> {
        let name = check_name(name)?;
        let account_id = match account_id {
            Some(id) => id,
            None => {
                let mut found = None;
                for account in self.inner.store.accounts()? {
                    if self.inner.contacts_source(&account.id).await.is_ok() {
                        found = Some(account.id);
                        break;
                    }
                }
                found.ok_or_else(|| Error::not_supported("None of your mailboxes has address books."))?
            }
        };
        let remote = match self.inner.contacts_source(&account_id).await? {
            Source::Jmap => jmap_contacts::create_book(&*self.inner.jmap_client(&account_id).await?, name).await?,
            Source::Dav { client, home } => carddav::make_book(&client, &home, name).await?.path().to_string(),
        };
        self.inner.contacts_changed(&account_id);
        let id = contacts::app_id(&account_id, &remote);
        self.inner
            .address_book_entries(&account_id)
            .await?
            .into_iter()
            .find(|entry| entry.info.id == id)
            .map(|entry| entry.info)
            .ok_or_else(|| Error::internal("The new address book didn't show up."))
    }

    pub async fn rename_address_book(&self, book_id: &str, name: &str) -> Result<()> {
        let name = check_name(name)?;
        let (source, entry) = self.inner.book_entry(book_id).await?;
        match source {
            Source::Jmap => {
                let client = self.inner.jmap_client(&entry.info.account_id).await?;
                jmap_contacts::rename_book(&client, &entry.remote, name).await?;
            }
            Source::Dav { client, home } => {
                carddav::rename_book(&client, &contacts::dav_url(&home, &entry.remote)?, name).await?;
            }
        }
        self.inner.contacts_changed(&entry.info.account_id);
        Ok(())
    }

    /// Deletes an address book with its contacts. The last one of an account stays.
    pub async fn delete_address_book(&self, book_id: &str) -> Result<()> {
        let (source, entry) = self.inner.book_entry(book_id).await?;
        let account_id = entry.info.account_id.clone();
        if !entry.info.may_delete {
            return Err(Error::invalid("This address book can't be deleted."));
        }
        if self.inner.address_book_entries(&account_id).await?.len() <= 1 {
            return Err(Error::invalid("The only address book of a mailbox stays."));
        }
        match source {
            Source::Jmap => {
                jmap_contacts::delete_book(&*self.inner.jmap_client(&account_id).await?, &entry.remote).await?
            }
            Source::Dav { client, home } => {
                let url = contacts::dav_url(&home, &entry.remote)?;
                dav::delete(&client, &url, None).await?;
                self.inner.store.forget_address_book(book_id)?;
            }
        }
        self.inner.contacts_changed(&account_id);
        Ok(())
    }

    pub async fn set_default_address_book(&self, book_id: &str) -> Result<()> {
        let (source, entry) = self.inner.book_entry(book_id).await?;
        match source {
            Source::Jmap => {
                let client = self.inner.jmap_client(&entry.info.account_id).await?;
                jmap_contacts::set_default_book(&client, &entry.remote).await?;
            }
            Source::Dav { .. } => self.inner.store.set_default_address_book(&entry.info.account_id, book_id)?,
        }
        self.inner.contacts_changed(&entry.info.account_id);
        Ok(())
    }

    /// Every card of every account, with the app's ids. Accounts that can't be reached are left out.
    pub async fn contact_cards(&self) -> Result<Vec<ContactCardEntry>> {
        let accounts = self.inner.store.accounts()?;
        let reads = accounts.iter().map(|account| self.inner.remote_cards(&account.id));
        let mut found = Vec::new();
        for (account, read) in accounts.iter().zip(futures::future::join_all(reads).await) {
            match read {
                Ok(cards) => found.extend(cards.iter().map(|card| ContactCardEntry {
                    account_id: account.id.clone(),
                    card: contacts::app_card(&account.id, card),
                })),
                Err(error) if error.code == ErrorCode::NotSupported => {}
                Err(error) => tracing::warn!("Contacts of {} couldn't be read: {error}", account.id),
            }
        }
        Ok(found)
    }

    /// One card as the server has it now, to change it.
    pub async fn contact_card(&self, card_id: &str) -> Result<Value> {
        let (account_id, remote) = contacts::split_id(card_id)?;
        let card = match self.inner.contacts_source(account_id).await? {
            Source::Jmap => jmap_contacts::card(&*self.inner.jmap_client(account_id).await?, remote).await?,
            Source::Dav { client, home } => {
                let read = read_dav_card(&client, &home, remote).await?;
                let book = read
                    .url
                    .path()
                    .rsplit_once('/')
                    .map(|(parent, _)| format!("{parent}/"))
                    .ok_or_else(|| Error::not_found("This contact no longer exists."))?;
                RemoteCard { remote: remote.to_string(), book_remote: book, card: read.card }
            }
        };
        Ok(contacts::app_card(account_id, &card))
    }

    /// Creates a card (JSContact) in an address book and returns its id.
    pub async fn create_contact_card(&self, address_book_id: &str, card: Value) -> Result<String> {
        let (source, book) = self.inner.book_entry(address_book_id).await?;
        if !book.info.may_write {
            return Err(Error::invalid("This address book is read-only."));
        }
        let account_id = book.info.account_id.clone();
        let mut card = card_object(card)?;
        let remote = match source {
            Source::Jmap => {
                jmap_contacts::create_card(&*self.inner.jmap_client(&account_id).await?, &book.remote, card).await?
            }
            Source::Dav { client, home } => {
                let now = now_utc_text();
                card.insert("@type".into(), json!("Card"));
                card.entry("version").or_insert_with(|| json!("1.0"));
                let uid = match card.get("uid").and_then(Value::as_str) {
                    Some(uid) if !uid.trim().is_empty() => uid.to_string(),
                    _ => format!("urn:uuid:{}", uuid::Uuid::new_v4()),
                };
                card.insert("uid".into(), json!(uid));
                card.entry("created").or_insert_with(|| json!(now));
                card.insert("updated".into(), json!(now));
                let text = vcard_text(&card)?;
                let book_url = contacts::dav_url(&home, &book.remote)?;
                let url = book_url
                    .join(&vcard::file_name(&uid))
                    .map_err(|_| Error::internal("The contact's address couldn't be built."))?;
                carddav::put_card(&client, &url, &text, None).await?;
                url.path().to_string()
            }
        };
        self.inner.contacts_changed(&account_id);
        Ok(contacts::app_id(&account_id, &remote))
    }

    /// Changes a card with a JMAP patch (RFC 8620 PatchObject). `addressBookIds` with an app id
    /// moves it to that address book of the same mailbox.
    pub async fn update_contact_card(&self, card_id: &str, patch: Map<String, Value>) -> Result<()> {
        let (account_id, remote) = contacts::split_id(card_id)?;
        let mut patch = patch;
        if let Some(key) = patch.keys().find(|key| IMMUTABLE.contains(&key.split('/').next().unwrap_or_default())) {
            return Err(Error::invalid(format!("\"{key}\" of a contact can't be changed.")));
        }
        let target = match patch.remove("addressBookIds") {
            Some(Value::Object(books)) => {
                let target = books
                    .iter()
                    .find(|(_, on)| on.as_bool() == Some(true))
                    .map(|(id, _)| id.clone())
                    .ok_or_else(|| Error::invalid("A contact belongs to one address book."))?;
                let (target_account, _) = contacts::split_id(&target)?;
                if target_account != account_id {
                    return Err(Error::invalid("Contacts can't move to an address book of another mailbox."));
                }
                let (_, entry) = self.inner.book_entry(&target).await?;
                if !entry.info.may_write {
                    return Err(Error::invalid("This address book is read-only."));
                }
                Some(entry)
            }
            Some(_) => return Err(Error::invalid("A contact belongs to one address book.")),
            None => None,
        };
        if patch.keys().any(|key| key.starts_with("addressBookIds/")) {
            return Err(Error::invalid("Move a contact by giving its new address book."));
        }
        match self.inner.contacts_source(account_id).await? {
            Source::Jmap => {
                if let Some(target) = &target {
                    patch.insert("addressBookIds".into(), json!({ target.remote.clone(): true }));
                }
                jmap_contacts::update_card(&*self.inner.jmap_client(account_id).await?, remote, patch).await?;
            }
            Source::Dav { client, home } => {
                let read = read_dav_card(&client, &home, remote).await?;
                let mut card = Value::Object(read.card);
                jscal::apply_patch(&mut card, &patch)?;
                let Value::Object(mut card) = card else {
                    return Err(Error::internal("The contact isn't an object any more."));
                };
                card.insert("updated".into(), json!(now_utc_text()));
                let text = vcard_text(&card)?;
                let target_url = match &target {
                    Some(entry) => Some(contacts::dav_url(&home, &entry.remote)?),
                    None => None,
                };
                match target_url.filter(|url| !read.url.path().starts_with(url.path())) {
                    None => {
                        carddav::put_card(&client, &read.url, &text, read.etag.as_deref()).await?;
                    }
                    Some(target_url) => {
                        // Moving between address books: write it there, then take it away here.
                        let name =
                            read.url.path_segments().and_then(|mut s| s.next_back()).unwrap_or("card.vcf").to_string();
                        let moved = target_url
                            .join(&name)
                            .map_err(|_| Error::internal("The contact's address couldn't be built."))?;
                        carddav::put_card(&client, &moved, &text, None).await?;
                        dav::delete(&client, &read.url, read.etag.as_deref()).await?;
                    }
                }
            }
        }
        self.inner.contacts_changed(account_id);
        Ok(())
    }

    pub async fn delete_contact_card(&self, card_id: &str) -> Result<()> {
        let (account_id, remote) = contacts::split_id(card_id)?;
        match self.inner.contacts_source(account_id).await? {
            Source::Jmap => jmap_contacts::destroy_card(&*self.inner.jmap_client(account_id).await?, remote).await?,
            Source::Dav { client, home } => dav::delete(&client, &contacts::dav_url(&home, remote)?, None).await?,
        }
        self.inner.contacts_changed(account_id);
        Ok(())
    }

    /// Recipient suggestions: people from the address books first, then addresses learned from
    /// mail. An account whose contacts don't come quickly is left out this time.
    pub async fn recipient_suggestions(&self, query: &str) -> Result<Vec<Contact>> {
        let accounts = self.inner.store.accounts()?;
        let own: HashSet<String> = accounts.iter().map(|account| account.email.to_lowercase()).collect();
        let reads =
            accounts.iter().map(|account| tokio::time::timeout(SUGGESTION_WAIT, self.inner.remote_cards(&account.id)));
        let mut found: Vec<Contact> = Vec::new();
        for read in futures::future::join_all(reads).await {
            if let Ok(Ok(cards)) = read {
                found.extend(suggestions_from(&cards, query));
            }
        }
        found.extend(self.search_contacts(query)?);
        let mut seen = HashSet::new();
        found.retain(|contact| {
            let email = contact.email.to_lowercase();
            !own.contains(&email) && seen.insert(email)
        });
        found.truncate(SUGGESTIONS);
        Ok(found)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote(card: Value) -> RemoteCard {
        let Value::Object(card) = card else { unreachable!() };
        RemoteCard { remote: "k".into(), book_remote: "b".into(), card }
    }

    #[test]
    fn cards_are_named_by_their_name_then_their_company() {
        assert_eq!(card_name(&json!({ "name": { "full": " Mina Sommer " } })).as_deref(), Some("Mina Sommer"));
        assert_eq!(
            card_name(&json!({ "name": { "components": [
                { "kind": "given", "value": "Mina" }, { "kind": "separator", "value": " " },
                { "kind": "surname", "value": "Sommer" }
            ] } }))
            .as_deref(),
            Some("Mina Sommer")
        );
        assert_eq!(
            card_name(&json!({ "organizations": { "o": { "name": "Nyu & Co" } } })).as_deref(),
            Some("Nyu & Co")
        );
        assert_eq!(card_name(&json!({})), None);
    }

    #[test]
    fn suggestions_match_names_and_addresses() {
        let cards = [
            remote(json!({ "name": { "full": "Mina Sommer" }, "emails": {
                "e1": { "address": "mina@example.org" }, "e2": { "address": "sommer@example.com" }
            } })),
            remote(json!({ "name": { "full": "Otto" }, "emails": { "e1": { "address": "otto@example.net" } } })),
        ];
        let by = |query: &str| suggestions_from(&cards, query).into_iter().map(|c| c.email).collect::<Vec<_>>();
        let mut mina = by("sommer");
        mina.sort();
        assert_eq!(mina, ["mina@example.org", "sommer@example.com"]);
        assert_eq!(by("OTTO@"), ["otto@example.net"]);
        assert!(by("  ").is_empty());
        assert_eq!(suggestions_from(&cards, "mina")[0].name.as_deref(), Some("Mina Sommer"));
    }

    #[test]
    fn written_cards_leave_the_app_ids_behind() {
        let card = card_object(json!({ "id": "a:k", "addressBookIds": { "a:b": true }, "uid": "x" })).unwrap();
        assert_eq!(Value::Object(card), json!({ "uid": "x" }));
        assert!(card_object(json!(["not", "a", "card"])).is_err());
    }

    #[tokio::test]
    async fn microsoft_and_google_mailboxes_have_no_address_books() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(crate::secrets::MemorySecrets::default());
        let engine = Engine::new(EngineOptions {
            data_dir: dir.path().to_path_buf(),
            secrets: secrets.clone(),
            open_url: Arc::new(|_| {}),
        })
        .unwrap();
        engine
            .inner
            .store
            .insert_account(&AccountRecord {
                id: "m".into(),
                name: "Work".into(),
                email: "alex@example-company.de".into(),
                display_name: "Alex".into(),
                color: AccountColor::Sky,
                auth: AuthKind::Microsoft,
                username: "alex@example-company.de".into(),
                imap: ServerSettings { host: "outlook.office365.com".into(), port: 993, security: Security::Tls },
                smtp: ServerSettings { host: "smtp.office365.com".into(), port: 587, security: Security::Starttls },
                protocol: Protocol::Imap,
                jmap_url: None,
            })
            .unwrap();
        secrets.set("m", &Secret::OAuth { refresh_token: "r".into() }).unwrap();

        let accounts = engine.contacts_accounts().await.unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].source, None);
        assert!(accounts[0].problem.as_deref().unwrap().contains("Microsoft"));
        // Leaving it out is not an error for the contacts as a whole.
        assert!(engine.address_books().await.unwrap().is_empty());
        assert!(engine.contact_cards().await.unwrap().is_empty());
        let refused = engine.create_address_book(Some("m".into()), "X").await;
        assert_eq!(refused.unwrap_err().code, ErrorCode::NotSupported);
        // Suggestions still come from mail.
        assert!(engine.recipient_suggestions("alex").await.unwrap().is_empty());
        // Only HTTPS addresses can be typed in.
        assert!(engine.set_carddav_url("m", Some("http://dav.example-company.de/")).await.is_err());
        assert!(engine.set_carddav_url("m", Some("https://dav.example-company.de/")).await.is_ok());
        // Changing a card never touches its uid.
        let mut patch = Map::new();
        patch.insert("uid".into(), json!("other"));
        assert_eq!(engine.update_contact_card("m:/x.vcf", patch).await.unwrap_err().code, ErrorCode::InvalidInput);
    }
}
