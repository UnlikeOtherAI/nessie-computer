//! Gives the Windows executable the executor's icon and the name in
//! `[package.metadata.tauri-winres]`, which Task Manager and the file's
//! properties show. Without them the process is a bare file name beside the
//! generic program icon. The `.ico` is the one the installer's Apps & features
//! entry uses, drawn by `executor/scripts/generate-icons.mjs`.
//!
//! The dependency is declared for Windows targets only, so every other build
//! stays exactly as it was.

fn build_identity() {
    use std::{path::PathBuf, process::Command};
    println!("cargo:rerun-if-env-changed=NESSIE_EXECUTOR_VERSION");
    let version = std::env::var("NESSIE_EXECUTOR_VERSION").unwrap_or_else(|_| "development".into());
    if version != "development" {
        let parts: Vec<_> = version.split('.').collect();
        assert!(parts.len() == 3 && parts.iter().all(|part| !part.is_empty()
            && (part.len() == 1 || !part.starts_with('0')) && part.parse::<u16>().is_ok()),
            "NESSIE_EXECUTOR_VERSION must be a three-part package version");
    }
    println!("cargo:rustc-env=NESSIE_EXECUTOR_VERSION={version}");
    let source = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo provides its source directory"));
    let git = |args: &[&str]| -> Option<String> {
        let output = Command::new("git").args(args).current_dir(&source).output().ok()?;
        output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    };
    let revision = git(&["rev-parse", "HEAD"]).filter(|value| value.len() == 40
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())).unwrap_or_else(|| "development".into());
    println!("cargo:rustc-env=NESSIE_EXECUTOR_SOURCE_COMMIT={revision}");
    for argument in ["--git-dir", "--git-common-dir"] {
        if let Some(directory) = git(&["rev-parse", "--path-format=absolute", argument]) {
            let directory = PathBuf::from(directory);
            let head = directory.join("HEAD");
            if head.exists() { println!("cargo:rerun-if-changed={}", head.display()); }
            let packed = directory.join("packed-refs");
            if packed.exists() { println!("cargo:rerun-if-changed={}", packed.display()); }
            if let Some(reference) = git(&["symbolic-ref", "-q", "HEAD"]) {
                let path = directory.join(reference);
                if path.exists() { println!("cargo:rerun-if-changed={}", path.display()); }
            }
        }
    }
}

fn main() {
    build_identity();
    // The publisher pin is compiled into the helper. Changing release team
    // must rebuild it; a runtime environment variable cannot change trust.
    println!("cargo:rerun-if-env-changed=NESSIE_DESKTOP_SIGNING_TEAM_ID");
    println!("cargo:rerun-if-env-changed=NESSIE_DESKTOP_WINDOWS_SIGNER_EKU");
    #[cfg(windows)]
    {
        const ICON: &str = "../packaging/windows/assets/nessie-executor.ico";
        println!("cargo:rerun-if-changed={ICON}");
        println!("cargo:rerun-if-changed=Cargo.toml");
        tauri_winres::WindowsResource::new()
            .set_icon(ICON)
            .compile()
            .expect("the Windows resource (icon and version information) could not be compiled");
    }
}
