//! This service's release provenance.
//!
//! The decision, the Win32 verification, and every word of every refusal live in
//! `nessie-windows-provenance`, shared with the desktop shell so the three
//! Nessie binaries on a Windows machine cannot disagree about what a release is.
//! All this module adds is the publisher pinned into *this* build.

/// The Windows analogue of the pinned Developer ID team: the durable Artifact
/// Signing certificate-profile EKU compiled in at build time. A build without
/// it is a development build and never supervises a daemon.
#[cfg(not(debug_assertions))]
const PRODUCTION_WINDOWS_SIGNER_EKU: Option<&str> =
    option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU");

/// Refuses unless this executable is a release signed by the pinned publisher.
/// A development build skips the check exactly as the desktop companion does;
/// it also has no signature to read.
#[cfg(all(not(debug_assertions), windows))]
pub fn require_release_signature() -> Result<(), String> {
    nessie_windows_provenance::require_release_signature(PRODUCTION_WINDOWS_SIGNER_EKU)
}

#[cfg(all(not(debug_assertions), not(windows)))]
pub fn require_release_signature() -> Result<(), String> {
    Err(nessie_windows_provenance::UNVERIFIABLE_REASON.to_owned())
}

#[cfg(debug_assertions)]
pub fn require_release_signature() -> Result<(), String> {
    Ok(())
}
