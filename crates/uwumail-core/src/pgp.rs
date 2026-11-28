//! Inline OpenPGP (cleartext signature) detection and verification.
//!
//! Debian security notices and similar announcements arrive as
//! `-----BEGIN PGP SIGNED MESSAGE-----` ... `-----BEGIN PGP SIGNATURE-----`
//! wrapped text. UwUMail keeps the signed text as the body (so the reader sees
//! the announcement, not the armor), and verifies the signature against公钥 the
//! user imported. Verification is an explicit engine method: no network is
//! touched, no key is auto-fetched, and nothing is trusted that the user did
//! not import.

use pgp::composed::cleartext::CleartextSignedMessage;
use pgp::composed::{Deserializable, SignedPublicKey};
use pgp::types::{Fingerprint, PublicKeyTrait};
use serde::{Deserialize, Serialize};

/// A public key the user imported, with the identity shown in the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PgpKey {
    /// The key's fingerprint in upper-case hex (no spaces).
    pub fingerprint: String,
    /// First user id on the certificate, for the "trusted by" label (may be empty).
    pub user_id: String,
    /// The armored key, kept so the key can be re-parsed for verification.
    pub armor: String,
}

/// The outcome of verifying a message against the imported keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PgpVerifyStatus {
    /// No cleartext signature block was found in the body.
    NotSigned,
    /// A signature was found but no imported key could verify it.
    UnknownKey { fingerprint: Option<String> },
    /// An imported key verified the signature.
    Verified { fingerprint: String, user_id: String },
    /// A signature was found but verification failed (tampered or wrong key).
    Invalid,
}

/// Strip the cleartext signature armor from a body, returning the signed text.
///
/// The signed text is normalized to CRLF by rPGP; mail readers don't care, but
/// keep the original line endings by splitting on `from_string`'s normalized
/// output only when a signature was actually found.
pub fn cleartext_payload(body: &str) -> Option<(String, CleartextSignedMessage)> {
    if !body.contains("-----BEGIN PGP SIGNED MESSAGE-----") {
        return None;
    }
    // rPGP parses cleartext frames with LF-normalized lines; raw mail bodies
    // arrive with CRLF. Normalize before handing it over (the signed text rPGP
    // returns is itself CRLF-normalized per RFC 4880).
    let normalized = body.replace("\r\n", "\n").replace('\r', "\n");
    // Raw mail often appends a blank line after the armor; rPGP treats that
    // as trailing data. Cut at the end marker before parsing.
    let normalized = match normalized.find("-----END PGP SIGNATURE-----") {
        Some(i) => {
            let end = i + "-----END PGP SIGNATURE-----".len();
            normalized[..end].to_string()
        }
        None => normalized,
    };
    match CleartextSignedMessage::from_string(&normalized) {
        Ok((msg, _headers)) => Some((msg.signed_text(), msg)),
        Err(_) => None,
    }
}

/// Get the original, still-armored body from raw RFC 5322 bytes. Verification
/// needs the signature block that `mime::parse` strips for display.
pub fn armored_from_raw(raw: &[u8]) -> Option<String> {
    // Take the body as the bytes after the header/body separator. Using the
    // raw bytes (rather than a MIME parser's first text part) matters for
    // list mail with Resent-* headers, where the parser can expose a nested
    // message and hand back an empty `body_text(0)`.
    let header_end = find(raw, b"\r\n\r\n").map(|i| i + 4).or_else(|| find(raw, b"\n\n").map(|i| i + 2))?;
    let body = String::from_utf8_lossy(&raw[header_end..]);
    if body.contains("-----BEGIN PGP SIGNED MESSAGE-----") { Some(body.into_owned()) } else { None }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// The signing key's fingerprint from a cleartext signature block, if readable.
pub fn signing_fingerprint(body: &str) -> Option<String> {
    let (_text, msg) = cleartext_payload(body)?;
    let sig = msg.signatures().first()?;
    let fps: Vec<&Fingerprint> = sig.signature.config.issuer_fingerprint();
    fps.first().map(|fp| hex_upper(fp.as_bytes()))
}

/// Parse an armored public key and describe it for the key list.
pub fn parse_public_key(armor: &str) -> Result<PgpKey, String> {
    let armored = armor.trim();
    if !armored.contains("-----BEGIN PGP PUBLIC KEY BLOCK-----") {
        return Err("这不是 PGP 公钥（缺少 BEGIN PGP PUBLIC KEY BLOCK）".into());
    }
    let mut cursor = std::io::Cursor::new(armored.as_bytes());
    let (key, _) = SignedPublicKey::from_armor_single(&mut cursor).map_err(|e| format!("无法解析公钥：{e}"))?;
    let fingerprint = hex_upper(key.primary_key.fingerprint().as_bytes());
    let user_id = key
        .details
        .users
        .first()
        .map(|u| u.id.to_string())
        .map(|s| s.strip_prefix("User ID: ").unwrap_or(&s).trim_matches('"').to_string())
        .unwrap_or_default();
    Ok(PgpKey { fingerprint, user_id, armor: armored.to_string() })
}

/// Verify a cleartext-signed body against a list of imported keys.
pub fn verify(body: &str, keys: &[PgpKey]) -> PgpVerifyStatus {
    let Some((_text, msg)) = cleartext_payload(body) else {
        return PgpVerifyStatus::NotSigned;
    };
    let issuer = signing_fingerprint(body);
    for key in keys {
        let mut cursor = std::io::Cursor::new(key.armor.as_bytes());
        let Ok((public, _)) = SignedPublicKey::from_armor_single(&mut cursor) else {
            continue;
        };
        // A signature may be made by the primary key or by a signing subkey
        // (Debian's notices commonly use the latter). SignedPublicKey's
        // PublicKeyTrait only covers the primary, so try each subkey too.
        let matched =
            msg.verify(&public).is_ok() || public.public_subkeys.iter().any(|sub| msg.verify(&sub.key).is_ok());
        if matched {
            return PgpVerifyStatus::Verified { fingerprint: key.fingerprint.clone(), user_id: key.user_id.clone() };
        }
    }
    // A signature was present but no key matched: distinguish "unknown key"
    // from "wrong/tampered" as far as the header allows.
    if issuer.is_some() { PgpVerifyStatus::UnknownKey { fingerprint: issuer } } else { PgpVerifyStatus::Invalid }
}

fn hex_upper(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02X}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIGNED: &str = include_str!("../tests/pgp-fixtures/cleartext-msg-01.asc");
    const PUBLIC_KEY: &str = include_str!("../tests/pgp-fixtures/cleartext-public-key.asc");

    fn imported_key() -> PgpKey {
        parse_public_key(PUBLIC_KEY).unwrap()
    }

    #[test]
    fn verifies_a_real_cleartext_signature_and_extracts_clean_body() {
        let key = imported_key();
        assert!(!key.fingerprint.is_empty());

        let (clean, _) = cleartext_payload(SIGNED).expect("a cleartext signature block");
        assert!(!clean.contains("BEGIN PGP"));
        assert!(clean.contains("tofu"));

        assert_eq!(
            verify(SIGNED, &[key]),
            PgpVerifyStatus::Verified { fingerprint: imported_key().fingerprint, user_id: imported_key().user_id }
        );
    }

    #[test]
    fn unsigned_and_tampered_mail_are_never_verified() {
        let key = imported_key();
        assert_eq!(verify("just plain mail", &[key.clone()]), PgpVerifyStatus::NotSigned);

        // Tampering with the signed text breaks the signature.
        let tampered = SIGNED.replace("tofu", "poison");
        assert!(!matches!(verify(&tampered, &[key]), PgpVerifyStatus::Verified { .. }));
    }

    #[test]
    fn refuses_non_key_armor() {
        assert!(parse_public_key("hello").is_err());
        assert!(parse_public_key("-----BEGIN PGP PUBLIC KEY BLOCK-----\nbroken").is_err());
    }
}
