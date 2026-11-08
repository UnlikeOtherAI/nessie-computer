#[cfg(windows)] mod handles;
#[cfg(windows)] mod execution_settings;
#[cfg(windows)] mod execution_resource;
#[cfg(windows)] mod execution_link;
#[cfg(windows)] mod execution_snapshot;
#[cfg(all(windows, test))] mod execution_snapshot_tests;
#[cfg(all(windows, test))] mod execution_settings_tests;
#[cfg(windows)] mod resource;
#[cfg(windows)] mod sqlite;
#[cfg(windows)] mod sqlite_api;
#[cfg(windows)] mod sqlite_handles;
#[cfg(windows)] mod pipe;
#[cfg(windows)] mod lease;
#[cfg(windows)] mod consent;
#[cfg(windows)] use crate::owner_approval_windows as consent_auth;
#[cfg(windows)] mod consent_contract;
#[cfg(windows)] mod consent_peer;
#[cfg(windows)] mod consent_pipe;
#[cfg(windows)] mod consent_state;
#[cfg(windows)] mod consent_words;
#[cfg(windows)] mod issuer_contract;
#[cfg(windows)] mod issuer_store;
#[cfg(windows)] mod issuer_wire;
#[cfg(windows)] mod issuer_launch;
#[cfg(windows)] mod issuer_client;
#[cfg(windows)] mod issuer_signing;
#[cfg(windows)] pub(crate) mod issuer_service;
#[cfg(all(windows, test))] mod test_fixture;
#[cfg(all(windows, test))] mod tests;
#[cfg(all(windows, test))] mod pipe_tests;
#[cfg(all(windows, test))] mod consent_tests;

use crate::protocol::NativeError;

#[cfg(windows)]
pub fn run_execution() -> Result<(), NativeError> { execution_resource::run() }
#[cfg(not(windows))]
pub fn run_execution() -> Result<(), NativeError> { Err(NativeError::new("t3_execution_resource_platform_unsupported")) }

#[cfg(windows)]
pub fn approve_retained_import(nonce:&str) -> Result<(),NativeError> { consent::approve(nonce) }
#[cfg(windows)]
pub fn verify_retained_import() -> Result<(),NativeError> { consent::verify() }
#[cfg(not(windows))]
pub fn approve_retained_import(_nonce:&str) -> Result<(),NativeError> { Err(NativeError::new("retained_import_platform_unsupported")) }
#[cfg(not(windows))]
pub fn verify_retained_import() -> Result<(),NativeError> { Err(NativeError::new("retained_import_platform_unsupported")) }

#[cfg(windows)]
pub fn run() -> Result<(), NativeError> {
    if !cfg!(target_arch="x86_64") {return Err(NativeError::new("t3_source_native_platform_unsupported"));}
    use std::io::Read;
    nessie_windows_provenance::require_release_signature(option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU"))
        .map_err(|_| NativeError::new("t3_source_native_publisher_unverified"))?;
    // The timer bounds blocked pipe clients and SQLite as well as callbacks.
    // Exit closes every kernel/SQLite handle; no source writes need recovery.
    let clock = std::sync::Arc::new(lease::LeaseClock::new());
    let watchdog = clock.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if watchdog.check().is_err() { std::process::exit(1); }
    });
    let mut bytes = Vec::new();
    std::io::stdin().take(65537).read_to_end(&mut bytes).map_err(|_| handles::fail())?;
    if bytes.len() > 65536 { return Err(handles::fail()); }
    let request: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| handles::fail())?;
    let resource = resource::Resource::open_with_clock(&request, clock)?;
    pipe::serve(&request, resource)
}

#[cfg(not(windows))]
pub fn run() -> Result<(), NativeError> { Err(NativeError::new("t3_source_native_platform_unsupported")) }
