//! Gives the Windows executable the executor's icon and the name in
//! `[package.metadata.tauri-winres]`, which Task Manager and the file's
//! properties show. Without them the process is a bare file name beside the
//! generic program icon. The `.ico` is the one the installer's Apps & features
//! entry uses, drawn by `executor/scripts/generate-icons.mjs`.
//!
//! The dependency is declared for Windows targets only, so every other build
//! stays exactly as it was.

fn main() {
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
