//! What the Nessie Computer service and its tray both have to agree on.
//!
//! Three facts, and all are the kind that break silently when they are stated
//! twice: the account Windows derives from the service name — pick the two
//! separately and the grant names an account that never exists — the layout
//! under `%ProgramData%` that the tray writes into and the service reads out
//! of, and the string form of a SID, which the tray writes as a file name and
//! the service reads back and hands to Win32.
//!
//! The names and the validation are portable, so they are tested on any host.
//! The one Win32 call lives behind `cfg(windows)` in [`sid`].

#[cfg(windows)]
mod sid;

pub mod control_channel;
pub mod custody;
pub mod custody_store;
pub mod failure;
#[cfg(windows)]
pub mod custody_observation;
pub mod lease;
pub mod owner_controls;
pub mod inference_control;
#[cfg(windows)]
pub mod process;
#[cfg(windows)]
pub mod peer_inspection;
#[cfg(windows)]
pub mod installed;
#[cfg(windows)]
pub mod registry;
#[cfg(windows)]
pub mod release;
pub mod runtime;
#[cfg(windows)]
pub mod service_channel;
pub mod unpair;
#[cfg(windows)]
pub mod update_admission;
#[cfg(windows)]
pub mod update_runtime;
#[cfg(windows)]
pub mod update_channel;

#[cfg(windows)]
pub use sid::sid_to_string;

/// The Windows service name. `nessie-executor-service` registers under it and
/// the MSI authors the same string.
pub const SERVICE_NAME: &str = "NessieExecutor";

/// The service's control pipe: pairing, team controls and the owner's own
/// answers. The service, the Windows app and the command line's relay
/// (`control_channel`) all address it by this name.
pub const CONTROL_PIPE_NAME: &str = r"\\.\pipe\NessieExecutor";

/// Runtime admission only; pairing and machine control retain their separate ACL.
pub const CUSTODY_PIPE_NAME: &str = r"\\.\pipe\NessieExecutorCustody";

/// The account Windows creates for a service registered with that name and no
/// password. The workspace ACL grant and the Hyper-V group membership name it.
pub const SERVICE_ACCOUNT: &str = r"NT SERVICE\NessieExecutor";

/// The service's own directory name under `%ProgramData%`. Pairing material
/// and machine keys belong to the service account, not to a person's profile,
/// so everything the service keeps lives under it.
pub const SERVICE_DIRECTORY_NAME: &str = "Nessie Executor";

/// The directory under the service root where an elevated grant records the
/// accounts the control pipe admits, one marker file per SID.
pub const CONTROL_CLIENTS_DIRECTORY: &str = "control-clients";

/// The directory under the service root the service writes its log into and
/// the tray's **Open logs folder** opens.
pub const LOGS_DIRECTORY: &str = "logs";

/// The only file rights a tray control client receives on the named pipe. This
/// deliberately excludes `FILE_APPEND_DATA`, which Windows treats as the
/// right to create another named-pipe instance.
pub const CONTROL_PIPE_CLIENT_ACCESS: u32 = 0x0012_018B;

/// A SID in its string form, checked before it is ever handed to Win32 or used
/// as a file name: `S-1-` followed by dash-separated decimal parts.
pub fn is_sid_string(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("S-1-") else {
        return false;
    };
    !rest.is_empty()
        && value.len() <= 187
        && rest.split('-').all(|part| {
            !part.is_empty() && part.len() <= 20 && part.bytes().all(|byte| byte.is_ascii_digit())
        })
}

#[cfg(test)]
mod tests {
    use super::{
        is_sid_string, CONTROL_CLIENTS_DIRECTORY, CONTROL_PIPE_CLIENT_ACCESS, LOGS_DIRECTORY,
        SERVICE_ACCOUNT, SERVICE_DIRECTORY_NAME, SERVICE_NAME,
    };

    /// Windows derives the virtual account from the service name; choosing them
    /// separately would produce an account that never exists.
    #[test]
    fn the_service_account_is_this_services_virtual_account() {
        assert_eq!(SERVICE_ACCOUNT, format!(r"NT SERVICE\{SERVICE_NAME}"));
        assert!(!SERVICE_NAME.contains(' '));
    }

    /// The tray records a grant and opens the logs where the service reads and
    /// writes them; the installer authors the same root. One spelling each, and
    /// each a single path segment — a separator would put the marker somewhere
    /// the service never lists.
    #[test]
    fn the_program_data_layout_is_the_one_the_service_and_tray_share() {
        assert_eq!(SERVICE_DIRECTORY_NAME, "Nessie Executor");
        assert_eq!(CONTROL_CLIENTS_DIRECTORY, "control-clients");
        assert_eq!(LOGS_DIRECTORY, "logs");
        for name in [
            SERVICE_DIRECTORY_NAME,
            CONTROL_CLIENTS_DIRECTORY,
            LOGS_DIRECTORY,
        ] {
            assert!(
                !name.is_empty() && !name.contains(['\\', '/']),
                "{name:?} must be one segment"
            );
        }
    }

    #[test]
    fn only_a_well_formed_sid_string_is_accepted() {
        assert!(is_sid_string(
            "S-1-5-21-1004336348-1177238915-682003330-1001"
        ));
        assert!(is_sid_string("S-1-5-32-544"));
        for value in [
            "",
            "S-1-",
            "s-1-5-32-544",
            "S-1-5-32-",
            "S-1-5--544",
            "S-1-5-32-544; DROP",
            "Everyone",
            "..\\..\\windows",
        ] {
            assert!(!is_sid_string(value), "SID {value:?} must be refused");
        }
    }

    #[test]
    fn control_clients_cannot_create_a_second_pipe_instance() {
        assert_eq!(CONTROL_PIPE_CLIENT_ACCESS & 0x0000_0004, 0);
    }
}

#[cfg(windows)]
pub mod pipe_io;
