//! The system's text recognition (crates/uwumail-ocr) for the text in pictures of mailboxes whose
//! server doesn't read them: Vision on macOS and iOS, Windows.Media.Ocr on Windows, none on Linux.

use std::sync::Arc;

use uwumail_core::TextRecognizer;

struct SystemOcr;

impl TextRecognizer for SystemOcr {
    fn available(&self) -> bool {
        uwumail_ocr::available()
    }

    fn recognize(&self, image: &[u8]) -> Result<String, String> {
        uwumail_ocr::recognize(image)
    }
}

/// This platform's recognizer for the engine, `None` where there is none (the feature stays off).
pub fn recognizer() -> Option<Arc<dyn TextRecognizer>> {
    uwumail_ocr::SUPPORTED.then(|| Arc::new(SystemOcr) as Arc<dyn TextRecognizer>)
}
