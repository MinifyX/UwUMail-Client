//! Contact photos at Microsoft Graph and Google People. JMAP and CardDAV cards carry their photo
//! inside the card (JSContact `media`, a vCard PHOTO); these two keep it apart from the contact:
//! the app's card patch names it like any other, and here it is taken out and written with the
//! provider's own photo calls. Showing one asks the provider when the contact opens.

use base64::Engine as _;
use reqwest::Method;
use serde_json::{Map, Value, json};

use super::*;
use crate::cloud::{Api, Call, segment};
use crate::contacts::cloud_cards::{self, REMOTE_PHOTO};
use crate::contacts::{self, Source};
use crate::mail_images::image_media_type;

/// A contact photo the app made is a small JPEG; anything up to this is taken from the page.
const MAX_PHOTO: usize = 4 * 1024 * 1024;
/// A provider's photo is read up to this size.
const MAX_REMOTE_PHOTO: usize = 8 * 1024 * 1024;

/// A photo for a card: its type from its bytes, and the bytes.
pub(super) struct Photo {
    media_type: &'static str,
    bytes: Vec<u8>,
}

/// A picture inside a card (`data:image/…;base64,…`), checked: JPEG, PNG, WebP or GIF.
fn photo_from_uri(uri: &str) -> Result<Photo> {
    let (media_type, bytes) = crate::jmap_profile::picture_from_data_uri(uri, MAX_PHOTO as u64)?;
    Ok(Photo { media_type, bytes })
}

/// The photo change a card patch makes: `None` when it doesn't touch the photos, `Some(None)` to
/// remove the photo, `Some(Some(_))` for a new one. The photo parts are taken out of the patch.
pub(super) fn take_photo_change(patch: &mut Map<String, Value>) -> Result<Option<Option<Photo>>> {
    let keys: Vec<String> = patch.keys().filter(|key| *key == "media" || key.starts_with("media/")).cloned().collect();
    if keys.is_empty() {
        return Ok(None);
    }
    let mut new_photo = None;
    for key in keys {
        let value = patch.remove(&key).unwrap_or(Value::Null);
        // `media/p1` is one entry, `media` all of them.
        let entries: Vec<Value> = if key == "media" {
            value.as_object().map(|map| map.values().cloned().collect()).unwrap_or_default()
        } else if key.matches('/').count() == 1 {
            vec![value]
        } else {
            return Err(Error::invalid("A contact's photo is changed as a whole."));
        };
        for entry in entries {
            if entry.get("kind").and_then(Value::as_str) != Some("photo") {
                continue;
            }
            if let Some(uri) = entry.get("uri").and_then(Value::as_str)
                && uri.starts_with("data:")
                && new_photo.is_none()
            {
                new_photo = Some(photo_from_uri(uri)?);
            }
        }
    }
    Ok(Some(new_photo))
}

/// The photo of a new card, if it has one inside.
pub(super) fn photo_of_card(card: &mut Map<String, Value>) -> Result<Option<Photo>> {
    let Some(media) = card.remove("media") else { return Ok(None) };
    let uri = media
        .as_object()
        .into_iter()
        .flat_map(|map| map.values())
        .filter(|entry| entry.get("kind").and_then(Value::as_str) == Some("photo"))
        .find_map(|entry| entry.get("uri").and_then(Value::as_str).filter(|uri| uri.starts_with("data:")));
    uri.map(photo_from_uri).transpose()
}

fn data_uri(bytes: &[u8]) -> Option<String> {
    let media_type = image_media_type(bytes).filter(|t| *t != "image/svg+xml")?;
    Some(format!("data:{media_type};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

impl Inner {
    /// Writes or removes the photo of a Graph or Google contact.
    pub(super) async fn cloud_set_photo(
        &self,
        account_id: &str,
        source: &Source,
        remote: &str,
        photo: Option<&Photo>,
    ) -> Result<()> {
        let account = self.store.account(account_id)?;
        match source {
            Source::Graph { base } => {
                let path = format!("{base}/contacts/{}/photo/$value", segment(remote));
                match photo {
                    Some(photo) => {
                        let call = Call::new(Api::Graph, Method::PUT, path);
                        self.cloud_raw(&account, &call, Some((&photo.bytes, photo.media_type)), 64 * 1024).await?;
                    }
                    None => {
                        let call = Call::new(Api::Graph, Method::DELETE, path);
                        self.cloud_raw(&account, &call, None, 64 * 1024).await.map_err(|error| {
                            if error.code == ErrorCode::SignInAgain {
                                error
                            } else {
                                Error::not_supported(
                                    "Microsoft didn't let UwUMail remove this photo. Outlook on the web can.",
                                )
                            }
                        })?;
                    }
                }
            }
            _ => {
                let resource = cloud_cards::google_resource(remote)
                    .ok_or_else(|| Error::invalid("That contact id makes no sense."))?;
                let call = match photo {
                    Some(photo) => {
                        Call::new(Api::GooglePeople, Method::PATCH, format!("{resource}:updateContactPhoto")).body(
                            json!({
                                "photoBytes": base64::engine::general_purpose::STANDARD.encode(&photo.bytes),
                                "personFields": "metadata",
                            }),
                        )
                    }
                    None => Call::new(Api::GooglePeople, Method::DELETE, format!("{resource}:deleteContactPhoto")),
                };
                self.cloud_call(&account, &call).await?;
            }
        }
        Ok(())
    }

    /// The photo Graph or Google keeps for a contact, as a `data:` URI; `None` without one.
    async fn cloud_photo(&self, account_id: &str, source: &Source, remote: &str) -> Result<Option<String>> {
        let account = self.store.account(account_id)?;
        let bytes = match source {
            Source::Graph { base } => {
                let call = Call::get(Api::Graph, format!("{base}/contacts/{}/photo/$value", segment(remote)));
                self.cloud_raw(&account, &call, None, MAX_REMOTE_PHOTO).await?
            }
            _ => {
                let cards = self.remote_cards(account_id).await?;
                let url = cards
                    .iter()
                    .find(|card| card.remote == remote)
                    .and_then(|card| card.card.get("media"))
                    .and_then(Value::as_object)
                    .into_iter()
                    .flat_map(|media| media.values())
                    .filter_map(|entry| entry.get("uri").and_then(Value::as_str))
                    .find(|url| cloud_cards::google_photo_url(url))
                    .map(String::from);
                match url {
                    Some(url) => fetch_google_photo(&url).await?,
                    None => None,
                }
            }
        };
        Ok(bytes.as_deref().and_then(data_uri))
    }
}

/// A Google photo link: no login goes along, no redirects are followed, and only a picture of a
/// sensible size comes back.
async fn fetch_google_photo(url: &str) -> Result<Option<Vec<u8>>> {
    if !cloud_cards::google_photo_url(url) {
        return Ok(None);
    }
    let client = crate::tls::http_client()?
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| Error::internal(format!("HTTP client setup failed: {e}")))?;
    let mut response = client.get(url).send().await?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > MAX_REMOTE_PHOTO {
            return Ok(None);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Some(bytes))
}

impl Engine {
    /// The photo a contact of Microsoft or Google has there, as a `data:` URI, or `None`. Cards of
    /// JMAP and CardDAV carry theirs inside and answer `None` here.
    pub async fn contact_photo(&self, card_id: &str) -> Result<Option<String>> {
        let (account_id, remote) = contacts::split_id(card_id)?;
        match self.inner.contacts_source(account_id).await? {
            source @ (Source::Graph { .. } | Source::Google) => {
                self.inner.cloud_photo(account_id, &source, remote).await
            }
            Source::Jmap | Source::Dav { .. } => Ok(None),
        }
    }
}

/// The marker cards of Graph and Google carry; it never goes back to the provider.
pub(super) fn drop_marker(card: &mut Map<String, Value>) {
    card.remove(REMOTE_PHOTO);
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0, 0, 0, 1, 0, 0, 0, 1, 8,
        6, 0, 0, 0,
    ];

    fn png_uri() -> String {
        format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(PNG))
    }

    #[test]
    fn finds_what_a_patch_does_to_the_photo() {
        let mut patch = Map::new();
        patch.insert("notes/n1/note".into(), json!("hi"));
        assert!(take_photo_change(&mut patch).unwrap().is_none());

        patch.insert("media/p1".into(), json!({ "kind": "photo", "uri": png_uri() }));
        patch.insert("media/p2".into(), Value::Null);
        let change = take_photo_change(&mut patch).unwrap().unwrap().unwrap();
        assert_eq!(change.media_type, "image/png");
        assert_eq!(patch.len(), 1, "the photo parts are taken out");

        patch.insert("media".into(), Value::Null);
        assert!(take_photo_change(&mut patch).unwrap().unwrap().is_none());
        patch.insert("media/p1".into(), Value::Null);
        assert!(take_photo_change(&mut patch).unwrap().unwrap().is_none());

        // A sound or a logo isn't the photo; a picture that isn't one is refused.
        patch.insert("media/s1".into(), json!({ "kind": "sound", "uri": "data:audio/ogg;base64,AAAA" }));
        assert!(take_photo_change(&mut patch).unwrap().unwrap().is_none());
        patch.insert("media/p1".into(), json!({ "kind": "photo", "uri": "data:image/png;base64,aGVsbG8=" }));
        assert!(take_photo_change(&mut patch).is_err());
        patch.insert("media/p1/uri".into(), json!("x"));
        assert!(take_photo_change(&mut patch).is_err());
    }

    #[test]
    fn a_new_card_hands_over_its_photo() {
        let mut card = Map::new();
        card.insert("media".into(), json!({ "p1": { "kind": "photo", "uri": png_uri() } }));
        assert!(photo_of_card(&mut card).unwrap().is_some());
        assert!(!card.contains_key("media"));
        assert!(photo_of_card(&mut card).unwrap().is_none());
    }

    #[test]
    fn only_pictures_become_data_uris() {
        assert!(data_uri(PNG).unwrap().starts_with("data:image/png;base64,"));
        assert!(data_uri(b"<html>").is_none());
        assert!(data_uri(b"<svg xmlns='http://www.w3.org/2000/svg'/>").is_none());
    }
}
