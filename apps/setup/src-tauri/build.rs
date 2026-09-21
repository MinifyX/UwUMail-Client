//! Packs the UwUMail app into the setup executable.
//!
//! `UWUMAIL_SETUP_PAYLOAD` points at the built app (`pnpm build:setup` sets it):
//! on Windows `uwumail-desktop.exe`, on macOS `UwUMail.app` and on Linux the
//! unpacked AppImage folder. A folder goes in as a tar, keeping file modes and
//! links. Without the variable the setup still builds, but can't install
//! anything, which is enough for checks and working on its UI.

use std::path::{Path, PathBuf};

/// Adds everything below `dir` to the tar, named relative to `root`, in a fixed order.
fn append_tree(tar: &mut tar::Builder<Vec<u8>>, root: &Path, dir: &Path) {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("can't read {}: {e}", dir.display()))
        .map(|entry| entry.expect("reading the app folder").path())
        .collect();
    entries.sort();
    for path in entries {
        let name = path.strip_prefix(root).expect("inside the app folder");
        tar.append_path_with_name(&path, name).unwrap_or_else(|e| panic!("can't pack {}: {e}", path.display()));
        let meta = std::fs::symlink_metadata(&path).expect("reading the app folder");
        if meta.is_dir() {
            append_tree(tar, root, &path);
        }
    }
}

fn pack(path: &Path) -> Vec<u8> {
    if path.is_dir() {
        let mut tar = tar::Builder::new(Vec::new());
        tar.follow_symlinks(false);
        append_tree(&mut tar, path, path);
        tar.into_inner().expect("finishing the tar")
    } else {
        std::fs::read(path).unwrap_or_else(|e| panic!("can't read {}: {e}", path.display()))
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=UWUMAIL_SETUP_PAYLOAD");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set")).join("payload.zst");
    match std::env::var_os("UWUMAIL_SETUP_PAYLOAD").filter(|path| !path.is_empty()) {
        Some(path) => {
            let path = Path::new(&path);
            println!("cargo:rerun-if-changed={}", path.display());
            let app = pack(path);
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
