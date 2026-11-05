//! Token-free stdin bridge from the interactive companion to its signed service.
use std::io::{Read, Write};

pub const SWITCH: &str = "--personal-attestation";
pub fn run(executor_id: &str) -> Result<(), String> {
    #[cfg(windows)]
    nessie_windows_provenance::require_release_signature(option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU"))?;
    if executor_id.len() != 36 || !executor_id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-') {
        return Err("Invalid paired computer identity.".into());
    }
    let mut bytes = Vec::new();
    std::io::stdin().take(16_385).read_to_end(&mut bytes).map_err(|_| "Personal attestation input unavailable.")?;
    if bytes.len() > 16_384 { return Err("Personal attestation input too large.".into()); }
    let operation: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid personal attestation input.")?;
    // The service parses the closed operation and verifies the impersonated
    // pipe caller against the pairing owner. This bridge signs nothing.
    let authority = crate::pipe_client::personal_attestation(&serde_json::json!({
        "command":"personalAttestation", "executorId":executor_id, "operation":operation,
    }))?;
    let bytes = serde_json::to_vec(&authority).map_err(|_| "Invalid personal attestation response.")?;
    std::io::stdout().write_all(&bytes).and_then(|()| std::io::stdout().write_all(b"\n"))
        .map_err(|_| "Personal attestation response unavailable.".into())
}
