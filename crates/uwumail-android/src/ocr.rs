//! The text in pictures of mailboxes whose server doesn't read them, with Google's ML Kit (Latin
//! script) from the Kotlin side (`PictureText.kt`). It is the Play services variant: the model comes
//! with Google Play services instead of with UwUMail, which keeps the app a few hundred kilobytes
//! bigger instead of several megabytes per architecture. Without Play services the feature is off.
//!
//! The picture goes over as a file in the app's cache: a path crosses the bridge, not megabytes of
//! base64. It is deleted right after.

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::json;
use uwumail_core::TextRecognizer;

use crate::bridge;

pub struct MlKit;

impl TextRecognizer for MlKit {
    fn available(&self) -> bool {
        matches!(bridge::call("pictureTextAvailable", &json!({})), Ok(Some(answer)) if answer == "true")
    }

    fn recognize(&self, image: &[u8]) -> Result<String, String> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = crate::host::cache_dir().join(format!(
            "ocr-{}-{}.img",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, image).map_err(|error| format!("Couldn't hand over the picture: {error}"))?;
        let answer = bridge::call("pictureText", &json!({ "path": path.to_string_lossy() }));
        let _ = std::fs::remove_file(&path);
        answer.map(Option::unwrap_or_default).map_err(|error| error.to_string())
    }
}
