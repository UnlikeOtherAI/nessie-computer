//! Whether a prior daemon still holds an executor's state directory.
//!
//! The daemon writes `daemon.pid` beside its state and releases it only after
//! every guest session has torn down. A second daemon over live guests is not
//! recoverable, so a lease held by a live process blocks a start; a lease left
//! behind by a crashed one must not block every later start forever, which is
//! why liveness is asked rather than assumed.
//!
//! Windows has no signals, so liveness is a process handle
//! (`PROCESS_QUERY_LIMITED_INFORMATION` + `GetExitCodeProcess`) — the narrowest
//! right that answers the question. The decision itself is a pure function, so
//! it is tested on any host.

use std::{fs, path::Path};

const DAEMON_LEASE_FILE: &str = "daemon.pid";

/// What a prior daemon's lease file says. A lease that cannot be read the way a
/// daemon writes it is `Suspect`, never absent: something holds that path.
#[derive(Debug, PartialEq, Eq)]
pub enum DaemonLease {
    Absent,
    Held(u32),
    Suspect,
}

pub fn read_daemon_lease(state_dir: &Path) -> DaemonLease {
    let lease = state_dir.join(DAEMON_LEASE_FILE);
    let Ok(metadata) = fs::symlink_metadata(&lease) else {
        return DaemonLease::Absent;
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return DaemonLease::Suspect;
    }
    let Ok(value) = fs::read_to_string(lease) else {
        return DaemonLease::Suspect;
    };
    match value.trim().parse::<u32>() {
        Ok(pid) if pid > 0 => DaemonLease::Held(pid),
        _ => DaemonLease::Suspect,
    }
}

/// Only a lease held by a process that is *still alive* blocks a start.
pub fn lease_blocks_start(lease: &DaemonLease, daemon_is_live: impl FnOnce(u32) -> bool) -> bool {
    match lease {
        DaemonLease::Absent => false,
        DaemonLease::Suspect => true,
        DaemonLease::Held(pid) => daemon_is_live(*pid),
    }
}

#[cfg(windows)]
pub fn daemon_is_live(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        // The process is gone, or is one this service may not open at all —
        // either way it is not a daemon of ours still tearing down guests.
        return false;
    }
    let mut code = 0_u32;
    let read = unsafe { GetExitCodeProcess(handle, &mut code) };
    unsafe { CloseHandle(handle) };
    // A pid whose exit code cannot be read is treated as alive: refusing a start
    // is recoverable, starting a second daemon over live guests is not.
    read == 0 || code == STILL_ACTIVE as u32
}

#[cfg(not(windows))]
pub fn daemon_is_live(pid: u32) -> bool {
    let _ = pid;
    // This service only ever runs on Windows; the non-Windows build exists so
    // the decisions above stay testable, and it must never claim a daemon is
    // gone on a host where it cannot look.
    true
}

/// A start is refused while a prior daemon still holds the state directory.
pub fn unowned_daemon_is_stopping(state_dir: &Path) -> bool {
    lease_blocks_start(&read_daemon_lease(state_dir), daemon_is_live)
}

#[cfg(test)]
mod tests {
    use super::{lease_blocks_start, read_daemon_lease, DaemonLease, DAEMON_LEASE_FILE};
    use std::fs;

    #[test]
    fn no_lease_never_blocks_a_start() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        assert_eq!(read_daemon_lease(directory.path()), DaemonLease::Absent);
        assert!(!lease_blocks_start(&DaemonLease::Absent, |_| true));
    }

    #[test]
    fn a_lease_naming_a_live_daemon_blocks_and_a_dead_one_does_not() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        fs::write(directory.path().join(DAEMON_LEASE_FILE), "4242\n").expect("lease");
        assert_eq!(read_daemon_lease(directory.path()), DaemonLease::Held(4242));
        assert!(lease_blocks_start(&DaemonLease::Held(4242), |pid| {
            assert_eq!(pid, 4242);
            true
        }));
        // A stale lease from a crashed daemon must not block every later start.
        assert!(!lease_blocks_start(&DaemonLease::Held(4242), |_| false));
    }

    #[test]
    fn an_unreadable_or_malformed_lease_is_suspect_and_blocks() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        for contents in ["", "  ", "0", "-1", "not-a-pid", "12 34"] {
            fs::write(directory.path().join(DAEMON_LEASE_FILE), contents).expect("lease");
            assert_eq!(
                read_daemon_lease(directory.path()),
                DaemonLease::Suspect,
                "lease {contents:?} must be suspect",
            );
        }
        // A suspect lease never consults liveness: there is no pid to ask about.
        assert!(lease_blocks_start(&DaemonLease::Suspect, |_| {
            panic!("liveness must not be asked about a lease with no pid")
        }));
    }
}
