//! The text in a mail's pictures (see `crate::ocr`): a UwUMail server reads them for its own
//! accounts, this device's OCR for every other mailbox.

use mail_parser::MessageParser;
use serde_json::json;

use super::*;
use crate::ocr;

/// Where one picture of a mail comes from.
enum Picture {
    /// The message's attachment (or embedded part) at this index.
    Part(usize),
    /// A remote picture of its HTML.
    Remote(String),
}

impl Engine {
    /// The text in a mail's pictures, e.g. for the dates on a poster. Remote pictures are only read
    /// with `remote`, which the reader passes once they may load for this mail: fetching them tells
    /// their senders the mail was opened, like showing them does.
    pub async fn image_text(&self, message_id: &str, remote: bool) -> Result<ImageTextResult> {
        let cached = self.inner.image_texts.lock().unwrap().get(message_id, remote);
        if let Some(result) = cached {
            return Ok(result);
        }
        let gone = || Error::not_found("This message no longer exists.");
        let ids = [message_id.to_string()];
        let message = self.inner.store.messages_by_ids(&ids)?.pop().ok_or_else(gone)?;
        let location = self.inner.store.locations(&ids)?.pop().ok_or_else(gone)?;
        let account = self.inner.store.account(&message.account_id)?;
        if account.protocol == Protocol::Jmap
            && let Some(email_id) = location.remote_id.as_deref()
        {
            let client = self.inner.jmap_client(&account.id).await?;
            if client.session.image_text {
                let result = server_image_text(&client, &message, email_id, remote).await?;
                if !result.unavailable {
                    self.remember_image_text(message_id, remote, &result);
                    return Ok(result);
                }
                // The server can't read pictures right now: this device does, as for other mailboxes.
            }
        }
        let (result, complete) = self.local_image_text(&message, &location, remote).await?;
        if complete {
            self.remember_image_text(message_id, remote, &result);
        }
        Ok(result)
    }

    fn remember_image_text(&self, message_id: &str, remote: bool, result: &ImageTextResult) {
        self.inner.image_texts.lock().unwrap().put(message_id, remote, result.clone());
    }

    /// Reads the pictures with this device's OCR. Also says whether every picture got its answer;
    /// a result with pictures that couldn't be fetched or read in time isn't kept.
    async fn local_image_text(
        &self,
        message: &Message,
        location: &MessageLocation,
        remote: bool,
    ) -> Result<(ImageTextResult, bool)> {
        let mut result =
            ImageTextResult { email_id: message.id.clone(), unavailable: true, images: Vec::new(), skipped: 0 };
        let Some(recognizer) = self.inner.recognizer.clone() else { return Ok((result, true)) };
        let asked = Arc::clone(&recognizer);
        if !tokio::task::spawn_blocking(move || asked.available()).await.unwrap_or(false) {
            // Maybe later (e.g. once Google Play services is there): not kept.
            return Ok((result, false));
        }
        result.unavailable = false;

        let mut pictures: Vec<(String, Picture)> = Vec::new();
        for (index, attachment) in message.attachments.iter().enumerate() {
            if !attachment.mime_type.trim().to_ascii_lowercase().starts_with("image/") {
                continue;
            }
            if ocr::readable_type(&attachment.mime_type) && attachment.size <= ocr::MAX_BYTES {
                pictures.push((ocr::part_source(attachment), Picture::Part(index)));
            } else {
                result.skipped += 1;
            }
        }
        if remote {
            for url in message.body_html.as_deref().map(ocr::remote_sources).unwrap_or_default() {
                pictures.push((url.clone(), Picture::Remote(url)));
            }
        }
        if pictures.len() > ocr::MAX_IMAGES {
            result.skipped += u32::try_from(pictures.len() - ocr::MAX_IMAGES).unwrap_or(u32::MAX);
            pictures.truncate(ocr::MAX_IMAGES);
        }

        let wanted: Vec<usize> = pictures
            .iter()
            .filter_map(|(_, picture)| if let Picture::Part(i) = picture { Some(*i) } else { None })
            .collect();
        let mut parts = self.picture_parts(&message.id, location, &wanted).await?;

        let deadline = Instant::now() + ocr::CALL_TIMEOUT;
        let mut complete = true;
        for (source, picture) in pictures {
            let bytes = match picture {
                Picture::Part(index) => parts.remove(&index),
                // The same way the reader gets them: through the UwUMail server or the privacy proxy.
                Picture::Remote(url) => self.mail_image(Some(&message.account_id), &url).await.map(|(_, bytes)| bytes),
            };
            let Some(bytes) = bytes else {
                result.skipped += 1;
                complete = false;
                continue;
            };
            let Some((width, height)) = ocr::picture_size(&bytes)
                .filter(|(width, height)| !ocr::too_small_or_big(*width, *height))
                .filter(|_| bytes.len() as u64 <= ocr::MAX_BYTES)
            else {
                result.skipped += 1;
                continue;
            };
            let left = deadline.saturating_duration_since(Instant::now());
            match self.recognize(&recognizer, bytes, left.min(ocr::RECOGNIZE_TIMEOUT)).await {
                Some(text) => {
                    let text = ocr::clean_text(&text);
                    if !text.is_empty() {
                        result.images.push(ImageText { source, text, width, height });
                    }
                }
                None => {
                    result.skipped += 1;
                    complete = false;
                }
            }
        }
        Ok((result, complete))
    }

    /// The bytes of the message's parts at `indexes`, from the attachment cache where they were
    /// saved before, else from the message, downloaded once for all of them. Parts too big to read
    /// or no longer there are left out.
    async fn picture_parts(
        &self,
        message_id: &str,
        location: &MessageLocation,
        indexes: &[usize],
    ) -> Result<HashMap<usize, Vec<u8>>> {
        let mut found = HashMap::new();
        let mut missing = Vec::new();
        for &index in indexes {
            let cached = self.inner.attachments.cached(message_id, index).and_then(|path| {
                let size = std::fs::metadata(&path).ok()?.len();
                (size <= ocr::MAX_BYTES).then(|| std::fs::read(&path).ok()).flatten()
            });
            match cached {
                Some(bytes) => {
                    found.insert(index, bytes);
                }
                None => missing.push(index),
            }
        }
        if missing.is_empty() {
            return Ok(found);
        }
        let raw = self.inner.raw_message(location).await?;
        let parsed =
            MessageParser::default().parse(&raw).ok_or_else(|| Error::internal("The message couldn't be read."))?;
        let decoded = crate::tnef::decode(&parsed);
        for (index, part) in crate::tnef::attachment_parts(&parsed, &decoded).into_iter().enumerate() {
            if missing.contains(&index) && part.data.len() as u64 <= ocr::MAX_BYTES {
                found.insert(index, part.data.into_owned());
            }
        }
        Ok(found)
    }

    /// The text the recognizer finds in a picture, `None` when it failed or took longer than `limit`.
    /// Pictures are read [`ocr::PARALLEL`] at a time on the whole device; one that is no longer
    /// waited for keeps its turn until the system is done with it.
    async fn recognize(
        &self,
        recognizer: &Arc<dyn crate::ocr::TextRecognizer>,
        image: Vec<u8>,
        limit: Duration,
    ) -> Option<String> {
        let work = async {
            let permit = Arc::clone(&self.inner.ocr_permits).acquire_owned().await.ok()?;
            let recognizer = Arc::clone(recognizer);
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                recognizer.recognize(&image)
            })
            .await
            .ok()
        };
        match tokio::time::timeout(limit, work).await {
            Ok(Some(Ok(text))) => Some(text),
            Ok(Some(Err(error))) => {
                tracing::debug!("Couldn't read a picture: {error}");
                None
            }
            Ok(None) | Err(_) => None,
        }
    }
}

/// Asks the UwUMail server (`Email/imageText`), with the attachments of the email in the same
/// request to put the app's ids in place of the server's.
async fn server_image_text(
    client: &JmapClient,
    message: &Message,
    email_id: &str,
    remote: bool,
) -> Result<ImageTextResult> {
    let account = client.account_id();
    let responses = client
        .call_within(
            vec![
                ("Email/imageText", json!({ "accountId": account, "emailId": email_id, "remote": remote })),
                (
                    "Email/get",
                    json!({
                        "accountId": account,
                        "ids": [email_id],
                        "properties": ["attachments"],
                        "bodyProperties": ["blobId", "cid", "name", "size", "type"],
                    }),
                ),
            ],
            // The server takes up to 90 seconds for a mail.
            ocr::CALL_TIMEOUT + Duration::from_secs(15),
        )
        .await?;
    let answer = responses.get(0, "Email/imageText")?;
    let parts = responses.get(1, "Email/get").map(ocr::server_parts).unwrap_or_default();
    Ok(ocr::from_server(&message.id, answer, &parts, &message.attachments))
}
