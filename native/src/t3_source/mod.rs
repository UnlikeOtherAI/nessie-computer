#[cfg(windows)] mod handles;
#[cfg(windows)] mod resource;
#[cfg(windows)] mod sqlite;
#[cfg(windows)] mod pipe;
#[cfg(all(windows, test))] mod test_fixture;
#[cfg(all(windows, test))] mod tests;
#[cfg(all(windows, test))] mod pipe_tests;

use crate::protocol::NativeError;

#[cfg(windows)]
pub fn run() -> Result<(), NativeError> {
    use std::io::Read;
    nessie_windows_provenance::require_release_signature(option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU"))
        .map_err(|_| NativeError::new("t3_source_native_publisher_unverified"))?;
    // The timer bounds blocked pipe clients and SQLite as well as callbacks.
    // Exit closes every kernel/SQLite handle; no source writes need recovery.
    std::thread::spawn(|| { std::thread::sleep(std::time::Duration::from_secs(60)); std::process::exit(1); });
    let mut bytes = Vec::new();
    std::io::stdin().take(65537).read_to_end(&mut bytes).map_err(|_| handles::fail())?;
    if bytes.len() > 65536 { return Err(handles::fail()); }
    let request: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| handles::fail())?;
    let resource = resource::Resource::open(&request)?;
    pipe::serve(&request, resource)
}

#[cfg(not(windows))]
pub fn run() -> Result<(), NativeError> { Err(NativeError::new("t3_source_native_platform_unsupported")) }
