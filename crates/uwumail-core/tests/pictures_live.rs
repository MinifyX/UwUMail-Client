//! Fetches sender pictures from real websites. Needs internet, so it only runs
//! with `UWUMAIL_TEST_INTERNET=1`.

use uwumail_core::pictures::{PictureKind, SenderPictures};

#[tokio::test]
async fn fetches_pictures_from_real_domains() {
    if std::env::var("UWUMAIL_TEST_INTERNET").is_err() {
        eprintln!("skipped: set UWUMAIL_TEST_INTERNET=1 to run");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    // Set UWUMAIL_TEST_PICTURES_DIR to keep the files for a look.
    let path = std::env::var("UWUMAIL_TEST_PICTURES_DIR").map(Into::into).unwrap_or_else(|_| dir.path().to_path_buf());
    // Straight from here, as an app without a proxy would.
    uwumail_core::tls::set_privacy_proxy("").unwrap();
    let pictures = SenderPictures::new(&path).unwrap();

    for email in ["news@mozilla.org", "noreply@github.com", "service@paypal.de", "no-reply@accounts.google.com"] {
        let picture = pictures.get(email, None).await.unwrap();
        match &picture {
            Some(found) => {
                let size = std::fs::metadata(&found.path).unwrap().len();
                println!("{email}: {:?} {} ({size} bytes)", found.kind, found.path.display());
            }
            None => println!("{email}: none"),
        }
    }

    // Personal addresses at mail providers never cause a request.
    assert!(pictures.get("someone@gmail.com", None).await.unwrap().is_none());
    // The second lookup comes from the cache.
    let github = pictures.get("support@github.com", None).await.unwrap();
    assert!(github.is_some_and(|p| matches!(p.kind, PictureKind::Logo | PictureKind::Icon)));
}
