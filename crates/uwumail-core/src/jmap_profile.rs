//! The own profile picture on a UwUMail server (`urn:uwumail:jmap:profile`, UwUMail-Server
//! docs/profile-pictures.md): the picture, who sees it, and whether mails carry it.
//!
//! The page crops the picture and hands over only the small square that comes out; the server
//! decodes it, cuts it again and writes it anew. The picture that comes back reaches the page as a
//! `data:` URI, and only when its bytes are a picture.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::error::{Error, ErrorCode, Result};
use crate::jmap::Client;
use crate::mail_images::image_media_type;

const ID: &str = "singleton";
/// What the server takes at most, whatever its capability says (docs: up to 10 MB).
pub const MAX_BYTES: usize = 10 * 1024 * 1024;
const VISIBILITIES: [&str; 3] = ["off", "server", "public"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileOptions {
    /// Largest upload in bytes.
    pub max_size: u64,
    /// False while an administrator switched public pictures off for the server or the domain.
    pub may_be_public: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePicture {
    /// The stored picture as a `data:` URI; `None` without one.
    pub url: Option<String>,
    /// `off`, `server` or `public`.
    pub visibility: String,
    pub send_face: bool,
    pub updated: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePatch {
    #[serde(default)]
    pub visibility: Option<String>,
    #[serde(default)]
    pub send_face: Option<bool>,
}

pub fn options(client: &Client) -> Option<ProfileOptions> {
    options_from(client.session.profile.as_ref()?)
}

pub fn options_from(capability: &Value) -> Option<ProfileOptions> {
    let capability = capability.as_object()?;
    let max_size = capability.get("maxSize").and_then(Value::as_u64).unwrap_or(MAX_BYTES as u64).min(MAX_BYTES as u64);
    Some(ProfileOptions {
        max_size,
        may_be_public: capability.get("mayBePublic").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn require(client: &Client) -> Result<ProfileOptions> {
    options(client).ok_or_else(|| Error::not_supported("This server keeps no profile pictures."))
}

/// A picture the page made, as `data:image/…;base64,…`: its type (from its bytes) and the bytes.
/// Only JPEG, PNG, WebP and GIF, within the server's size.
pub fn picture_from_data_uri(uri: &str, max_size: u64) -> Result<(&'static str, Vec<u8>)> {
    let unreadable = || Error::invalid("That picture couldn't be read.");
    let rest = uri.strip_prefix("data:").ok_or_else(unreadable)?;
    let (header, data) = rest.split_once(',').ok_or_else(unreadable)?;
    if !header.ends_with(";base64") {
        return Err(unreadable());
    }
    // Base64 takes four characters for three bytes; anything far bigger is refused before decoding.
    if data.len() / 4 * 3 > (max_size as usize).saturating_add(3) {
        return Err(Error::invalid("That picture is too big for the server."));
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|_| unreadable())?;
    if bytes.is_empty() {
        return Err(unreadable());
    }
    if bytes.len() as u64 > max_size {
        return Err(Error::invalid("That picture is too big for the server."));
    }
    let media_type = image_media_type(&bytes).filter(|t| *t != "image/svg+xml").ok_or_else(unreadable)?;
    Ok((media_type, bytes))
}

fn data_uri(media_type: &str, bytes: &[u8]) -> String {
    format!("data:{media_type};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn visibility_of(raw: &Value) -> String {
    raw.get("visibility").and_then(Value::as_str).filter(|v| VISIBILITIES.contains(v)).unwrap_or("server").to_string()
}

fn refusal(problem: &Value) -> Error {
    let kind = problem.get("type").and_then(Value::as_str).unwrap_or("serverFail");
    let description: String = problem
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or(kind)
        .chars()
        .filter(|c| !c.is_control())
        .take(300)
        .collect();
    let names_visibility = problem
        .get("properties")
        .and_then(Value::as_array)
        .is_some_and(|list| list.iter().any(|p| p.as_str() == Some("visibility")));
    match kind {
        "forbidden" => Error::new(ErrorCode::Forbidden, description),
        "invalidProperties" if names_visibility => Error::new(ErrorCode::Forbidden, description),
        "tooLarge" | "invalidProperties" | "blobNotFound" => Error::invalid(description),
        _ => Error::internal(description),
    }
}

/// The picture with who sees it; the picture itself is downloaded and checked.
pub async fn get(client: &Client) -> Result<ProfilePicture> {
    require(client)?;
    let arguments = json!({ "accountId": client.account_id(), "ids": [ID] });
    let responses = client.call(vec![("ProfilePicture/get", arguments)]).await?;
    let answer = responses.get(0, "ProfilePicture/get")?;
    let raw = answer.get("list").and_then(Value::as_array).and_then(|list| list.first()).cloned().unwrap_or(json!({}));
    let url = match raw.get("blobId").and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 255) {
        Some(blob_id) => {
            let bytes = client
                .download_within(client.account_id(), blob_id, "picture", "application/octet-stream", MAX_BYTES)
                .await?;
            // The type comes from the bytes, never from the server: only pictures reach the page.
            image_media_type(&bytes).filter(|t| *t != "image/svg+xml").map(|media_type| data_uri(media_type, &bytes))
        }
        None => None,
    };
    let updated = raw
        .get("updated")
        .and_then(Value::as_str)
        .filter(|text| text.len() <= 40 && !text.chars().any(char::is_control))
        .map(String::from);
    Ok(ProfilePicture {
        url,
        visibility: visibility_of(&raw),
        send_face: raw.get("sendFace").and_then(Value::as_bool) == Some(true),
        updated,
    })
}

async fn set(client: &Client, patch: Value) -> Result<()> {
    let arguments = json!({ "accountId": client.account_id(), "update": { ID: patch } });
    let responses = client.call(vec![("ProfilePicture/set", arguments)]).await?;
    let answer = responses.get(0, "ProfilePicture/set")?;
    if let Some(problem) = answer.get("notUpdated").and_then(|failed| failed.get(ID)) {
        return Err(refusal(problem));
    }
    Ok(())
}

/// Stores a new picture (a `data:` URI the page made) or removes it with `None`.
pub async fn set_picture(client: &Client, picture: Option<&str>) -> Result<ProfilePicture> {
    let options = require(client)?;
    let blob_id = match picture {
        Some(uri) => {
            let (media_type, bytes) = picture_from_data_uri(uri, options.max_size)?;
            Some(client.upload(bytes, media_type).await?)
        }
        None => None,
    };
    set(client, json!({ "blobId": blob_id })).await?;
    get(client).await
}

/// Changes who sees it and whether mails carry it.
pub async fn update(client: &Client, patch: &ProfilePatch) -> Result<()> {
    let options = require(client)?;
    let mut object = serde_json::Map::new();
    if let Some(visibility) = &patch.visibility {
        if !VISIBILITIES.contains(&visibility.as_str()) {
            return Err(Error::invalid("Nobody, the server or everyone sees the picture."));
        }
        if visibility == "public" && !options.may_be_public {
            return Err(Error::new(ErrorCode::Forbidden, "Public pictures are switched off here."));
        }
        object.insert("visibility".into(), json!(visibility));
    }
    if let Some(send_face) = patch.send_face {
        object.insert("sendFace".into(), json!(send_face));
    }
    if object.is_empty() {
        return Ok(());
    }
    set(client, Value::Object(object)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0, 0, 0, 1, 0, 0, 0, 1, 8,
        6, 0, 0, 0,
    ];

    #[test]
    fn reads_what_the_server_allows() {
        let options = options_from(&json!({ "maxSize": 1024, "mayBePublic": true })).unwrap();
        assert_eq!(options, ProfileOptions { max_size: 1024, may_be_public: true });
        // A server can't ask for more than any server takes.
        assert_eq!(options_from(&json!({ "maxSize": u64::MAX })).unwrap().max_size, MAX_BYTES as u64);
        assert!(!options_from(&json!({})).unwrap().may_be_public);
    }

    #[test]
    fn takes_only_pictures_within_the_size() {
        let uri = data_uri("image/jpeg", PNG);
        // The type comes from the bytes, not from what the URI claims.
        assert_eq!(picture_from_data_uri(&uri, 1024).unwrap().0, "image/png");
        assert!(picture_from_data_uri(&uri, 10).is_err());
        assert!(
            picture_from_data_uri(&data_uri("image/png", b"<svg xmlns='http://www.w3.org/2000/svg'/>"), 1024).is_err()
        );
        assert!(picture_from_data_uri(&data_uri("image/png", b"hello"), 1024).is_err());
        assert!(picture_from_data_uri("data:image/png,raw", 1024).is_err());
        assert!(picture_from_data_uri("https://example.com/a.png", 1024).is_err());
        assert!(picture_from_data_uri("data:image/png;base64,!!!", 1024).is_err());
        let huge = format!("data:image/png;base64,{}", "A".repeat(4000));
        assert!(picture_from_data_uri(&huge, 100).is_err());
    }

    #[test]
    fn refusals_name_a_forbidden_public_picture() {
        let forbidden = refusal(&json!({ "type": "invalidProperties", "properties": ["visibility"] }));
        assert_eq!(forbidden.code, ErrorCode::Forbidden);
        assert_eq!(refusal(&json!({ "type": "tooLarge" })).code, ErrorCode::InvalidInput);
        assert_eq!(visibility_of(&json!({ "visibility": "everyone" })), "server");
        assert_eq!(visibility_of(&json!({ "visibility": "off" })), "off");
    }
}
