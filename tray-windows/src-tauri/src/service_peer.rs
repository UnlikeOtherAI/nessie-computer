// Shared retained-process verification, also used by native custody clients.
#[cfg(windows)]
pub fn verify(pipe: windows_sys::Win32::Foundation::HANDLE) -> Result<(), String> {
    nessie_windows_common::service_channel::verify(
        pipe,
        option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU"),
    )
}
