//! Packs the UwUMail app into the setup executable.
//!
//! `UWUMAIL_SETUP_PAYLOAD` points at the built `uwumail-desktop.exe`
//! (`pnpm build:setup` sets it). Without it the setup still builds, but can't
//! install anything, which is enough for checks and working on its UI.

use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=UWUMAIL_SETUP_PAYLOAD");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set")).join("payload.zst");
    match std::env::var_os("UWUMAIL_SETUP_PAYLOAD").filter(|path| !path.is_empty()) {
        Some(path) => {
            let path = Path::new(&path);
            println!("cargo:rerun-if-changed={}", path.display());
            let app = std::fs::read(path).unwrap_or_else(|e| panic!("can't read {}: {e}", path.display()));
            let packed = zstd::encode_all(app.as_slice(), 19).expect("compressing the app");
            std::fs::write(&out, packed).expect("writing the payload");
            println!("cargo:rustc-env=UWUMAIL_SETUP_PAYLOAD_SIZE={}", app.len());
        }
        None => {
            std::fs::write(&out, []).expect("writing the empty payload");
            println!("cargo:rustc-env=UWUMAIL_SETUP_PAYLOAD_SIZE=0");
        }
    }
    // The setup usually runs from Downloads, next to whatever else was downloaded:
    // linked DLLs come from System32 only, never from the setup's own folder.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg-bins=/DEPENDENTLOADFLAG:0x800");
    }
    tauri_build::build()
}
