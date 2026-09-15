//! Things UwUMail was opened for: a `mailto:` link, files shared from another
//! app, or a tapped notification. Kotlin reports them, the UI picks them up.

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use uwumail_core::mailto::{self, MailtoDraft};
use uwumail_core::{Error, Result};

/// Shared files bigger than this don't fit a mail anyway and stay out of the draft.
const MAX_SHARED_BYTES: u64 = 25 * 1024 * 1024;

/// A file another app shared, copied into UwUMail's cache by Kotlin.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedFile {
    path: String,
    filename: String,
    mime_type: String,
    size: u64,
}

/// An attachment for the composer, in the same shape the UI sends back.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedAttachment {
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
    pub source: AttachmentSource,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AttachmentSource {
    Base64 { data: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LaunchAction {
    /// Open a draft, prefilled from a link or a share. `too_big` names shared
    /// files that were left out.
    #[serde(rename_all = "camelCase")]
    Compose { draft: MailtoDraft, attachments: Vec<SharedAttachment>, too_big: Vec<String> },
    /// Show a message, e.g. after tapping its notification.
    #[serde(rename_all = "camelCase")]
    Open { thread_id: String, message_id: String },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Reported {
    Mailto {
        url: String,
    },
    Share {
        #[serde(default)]
        subject: Option<String>,
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        files: Vec<SharedFile>,
    },
    #[serde(rename_all = "camelCase")]
    Open {
        thread_id: String,
        message_id: String,
    },
}

type Listener = Box<dyn Fn() + Send + Sync>;

static PENDING: Mutex<Option<LaunchAction>> = Mutex::new(None);
static LISTENER: OnceLock<Listener> = OnceLock::new();

/// Called when an action arrives, so an open window can react right away.
pub fn on_action(listener: impl Fn() + Send + Sync + 'static) {
    let _ = LISTENER.set(Box::new(listener));
}

/// The action waiting for the UI, handed out once.
pub fn take() -> Option<LaunchAction> {
    PENDING.lock().unwrap().take()
}

/// Reads a shared copy into the draft and removes it from the cache.
fn attach(file: SharedFile, attachments: &mut Vec<SharedAttachment>, too_big: &mut Vec<String>) {
    let path = Path::new(&file.path);
    if file.size > MAX_SHARED_BYTES {
        too_big.push(file.filename);
    } else {
        match std::fs::read(path) {
            Ok(bytes) => attachments.push(SharedAttachment {
                filename: file.filename,
                mime_type: file.mime_type,
                size: bytes.len() as u64,
                source: AttachmentSource::Base64 { data: base64::engine::general_purpose::STANDARD.encode(bytes) },
            }),
            Err(error) => tracing::warn!("Couldn't read a shared file: {error}"),
        }
    }
    if let Some(folder) = path.parent() {
        let _ = std::fs::remove_dir_all(folder);
    }
}

pub(crate) fn deliver(payload: serde_json::Value) -> Result<()> {
    let action = match serde_json::from_value::<Reported>(payload)? {
        Reported::Mailto { url } => LaunchAction::Compose {
            draft: mailto::parse(&url).ok_or_else(|| Error::invalid("That isn't a mailto: link."))?,
            attachments: Vec::new(),
            too_big: Vec::new(),
        },
        Reported::Share { subject, text, files } => {
            let (mut attachments, mut too_big) = (Vec::new(), Vec::new());
            // Together they have to fit one mail too, so many shared files can't fill the memory.
            let mut budget = MAX_SHARED_BYTES;
            for mut file in files {
                if file.size <= budget {
                    budget -= file.size;
                } else {
                    file.size = u64::MAX;
                }
                attach(file, &mut attachments, &mut too_big);
            }
            LaunchAction::Compose {
                draft: MailtoDraft {
                    subject: subject.unwrap_or_default(),
                    body: text.unwrap_or_default(),
                    ..MailtoDraft::default()
                },
                attachments,
                too_big,
            }
        }
        Reported::Open { thread_id, message_id } => LaunchAction::Open { thread_id, message_id },
    };
    *PENDING.lock().unwrap() = Some(action);
    if let Some(listener) = LISTENER.get() {
        listener();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shares_become_drafts_with_attachments() {
        let folder = std::env::temp_dir().join(format!("uwumail-share-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("a.txt");
        std::fs::write(&file, "nyu").unwrap();

        deliver(json!({
            "kind": "share",
            "text": "Look ✧",
            "files": [
                { "path": file, "filename": "a.txt", "mimeType": "text/plain", "size": 3 },
                { "path": folder.join("huge.mp4"), "filename": "huge.mp4", "mimeType": "video/mp4", "size": MAX_SHARED_BYTES + 1 }
            ]
        }))
        .unwrap();
        let Some(LaunchAction::Compose { draft, attachments, too_big }) = take() else { panic!("expected a draft") };
        assert_eq!(draft.body, "Look ✧");
        assert_eq!(attachments.len(), 1);
        let AttachmentSource::Base64 { data } = &attachments[0].source;
        assert_eq!(data, "bnl1");
        assert_eq!(too_big, ["huge.mp4"]);
        assert!(!folder.exists(), "the shared copy is cleaned up");
        assert!(take().is_none());

        deliver(json!({ "kind": "mailto", "url": "mailto:nyu@uwumail.test?subject=Hi" })).unwrap();
        let Some(LaunchAction::Compose { draft, .. }) = take() else { panic!("expected a draft") };
        assert_eq!(draft.to[0].email, "nyu@uwumail.test");
        assert_eq!(draft.subject, "Hi");

        // Two files that fit alone but not together: the second stays out.
        let (first, second) = (folder.join("one"), folder.join("two"));
        for part in [&first, &second] {
            std::fs::create_dir_all(part).unwrap();
            std::fs::write(part.join("clip.mp4"), "nyu").unwrap();
        }
        let twenty_megabytes = 20 * 1024 * 1024;
        deliver(json!({
            "kind": "share",
            "files": [
                { "path": first.join("clip.mp4"), "filename": "one.mp4", "mimeType": "video/mp4", "size": twenty_megabytes },
                { "path": second.join("clip.mp4"), "filename": "two.mp4", "mimeType": "video/mp4", "size": twenty_megabytes }
            ]
        }))
        .unwrap();
        let Some(LaunchAction::Compose { attachments, too_big, .. }) = take() else { panic!("expected a draft") };
        assert_eq!(attachments.len(), 1);
        assert_eq!(too_big, ["two.mp4"]);
        let _ = std::fs::remove_dir_all(&folder);
    }
}
