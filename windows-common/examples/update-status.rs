//! Read-only installed diagnostics; never grants authority or changes local policy.
#[cfg(windows)]
fn main() {
    let result = nessie_windows_common::update_channel::call(
        &serde_json::json!({"operation":"status"}),
        option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU"),
    );
    match result {
        Ok(status) => println!("{status}"),
        Err(reason) => { eprintln!("{reason}"); std::process::exit(1); }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("This installed-status diagnostic requires Windows.");
    std::process::exit(2);
}
