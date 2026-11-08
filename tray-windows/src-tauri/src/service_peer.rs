//! The release signer pin the tray holds the service's pipes to. The pipe
//! checks themselves are `nessie_windows_common`'s, shared with the command
//! line and native custody clients.

/// The EKU the official build pins; development builds name none.
pub const PIN: Option<&str> = option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU");
