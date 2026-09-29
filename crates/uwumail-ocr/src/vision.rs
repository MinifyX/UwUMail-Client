//! Vision's `VNRecognizeTextRequest` on macOS and iOS: the accurate recognizer with language
//! correction, detecting the language by itself where the system can (macOS 13, iOS 16).

use objc2::AnyThread;
use objc2::available;
use objc2::rc::{Retained, autoreleasepool};
use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
use objc2_vision::{VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel};

/// Where the language can't be detected (macOS 11 and 12), the ones recognized, in this order.
/// All of them are there from the second revision of the recognizer on.
const LANGUAGES: [&str; 6] = ["en-US", "de-DE", "fr-FR", "it-IT", "es-ES", "pt-BR"];

pub fn available() -> bool {
    available!(macos = 10.15, ios = 13.0)
}

pub fn recognize(image: &[u8]) -> Result<String, String> {
    if !available() {
        return Err("Text recognition needs macOS 10.15 or later.".into());
    }
    autoreleasepool(|_| {
        let data = NSData::with_bytes(image);
        let handler =
            VNImageRequestHandler::initWithData_options(VNImageRequestHandler::alloc(), &data, &NSDictionary::new());
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);
        if available!(macos = 13.0, ios = 16.0) {
            request.setAutomaticallyDetectsLanguage(true);
        } else if available!(macos = 11.0, ios = 14.0) {
            let languages: Vec<Retained<NSString>> = LANGUAGES.iter().map(|tag| NSString::from_str(tag)).collect();
            request.setRecognitionLanguages(&NSArray::from_retained_slice(&languages));
        }
        let generic: Retained<VNRequest> = Retained::into_super(Retained::into_super(request.clone()));
        handler
            .performRequests_error(&NSArray::from_retained_slice(&[generic]))
            .map_err(|error| error.localizedDescription().to_string())?;
        let lines: Vec<String> = request
            .results()
            .map(|results| results.to_vec())
            .unwrap_or_default()
            .iter()
            .filter_map(|observation| observation.topCandidates(1).firstObject())
            .map(|candidate| candidate.string().to_string())
            .collect();
        Ok(lines.join("\n"))
    })
}
