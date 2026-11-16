//! Read-only lifecycle observations shared by the Windows service and app.
//! The CLI owns atomic acquisition; this preflight never signals or deletes.
use std::{fs, io::Read, path::Path};

const DAEMON_LEASE_FILE: &str = "daemon.pid";

#[derive(Debug, PartialEq, Eq)]
pub enum DaemonLease {
    Absent,
    Legacy(u32),
    Generation {
        pid: u32,
        started_at: String,
        boot_id: Option<String>,
    },
    Suspect,
}

fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

fn parse(value: &str) -> DaemonLease {
    let value = value.trim();
    if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
        return match value.parse::<u32>() {
            Ok(pid) if pid > 0 && pid <= i32::MAX as u32 => DaemonLease::Legacy(pid),
            _ => DaemonLease::Suspect,
        };
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Claim {
        version: u8,
        pid: u32,
        started_at: String,
        token: String,
        boot_id: Option<String>,
    }
    let Ok(claim) = serde_json::from_str::<Claim>(value) else {
        return DaemonLease::Suspect;
    };
    let keys = serde_json::from_str::<serde_json::Value>(value)
        .ok()
        .and_then(|value| value.as_object().map(|object| object.len()));
    if claim.pid == 0
        || claim.pid > i32::MAX as u32
        || claim.started_at.is_empty()
        || !claim.started_at.bytes().all(|byte| byte.is_ascii_digit())
        || !uuid(&claim.token)
        || claim.token.as_bytes()[14] != b'4'
        || !matches!(claim.token.as_bytes()[19], b'8' | b'9' | b'a' | b'b')
        || match claim.version {
            1 => keys != Some(4) || claim.boot_id.is_some(),
            2 => keys != Some(5) || !claim.boot_id.as_deref().is_some_and(uuid),
            _ => true,
        }
    {
        return DaemonLease::Suspect;
    }
    DaemonLease::Generation {
        pid: claim.pid,
        started_at: claim.started_at,
        boot_id: claim.boot_id,
    }
}

fn read(state_dir: &Path) -> (DaemonLease, Option<fs::File>) {
    let path = state_dir.join(DAEMON_LEASE_FILE);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (DaemonLease::Absent, None)
        }
        Err(_) => return (DaemonLease::Suspect, None),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 4096 {
        return (DaemonLease::Suspect, None);
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let Ok(file) = options.open(path) else {
        return (DaemonLease::Suspect, None);
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if file.metadata().map_or(true, |value| {
            value.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        }) {
            return (DaemonLease::Suspect, None);
        }
    }
    let mut bytes = Vec::new();
    if (&file).take(4097).read_to_end(&mut bytes).is_err() || bytes.len() > 4096 {
        return (DaemonLease::Suspect, None);
    }
    let lease = std::str::from_utf8(&bytes).map_or(DaemonLease::Suspect, parse);
    (lease, Some(file))
}

pub fn read_daemon_lease(state_dir: &Path) -> DaemonLease {
    read(state_dir).0
}

#[derive(Debug)]
pub(super) enum ProcessFact {
    Absent,
    Present {
        started_at: String,
        sid: Option<String>,
    },
    Unknown,
}

fn blocks(
    lease: &DaemonLease,
    boot: Option<&str>,
    owner: Option<&str>,
    process: impl FnOnce(u32) -> ProcessFact,
) -> bool {
    let pid = match lease {
        DaemonLease::Absent => return false,
        DaemonLease::Suspect => return true,
        DaemonLease::Legacy(pid) => *pid,
        DaemonLease::Generation { pid, boot_id, .. } => {
            if let Some(expected) = boot_id {
                let Some(actual) = boot else { return true };
                if expected != actual {
                    return false;
                }
            }
            *pid
        }
    };
    match process(pid) {
        ProcessFact::Absent => false,
        ProcessFact::Unknown => true,
        ProcessFact::Present { started_at, sid } => match lease {
            DaemonLease::Generation {
                started_at: expected,
                ..
            } => expected == &started_at,
            // A legacy lease has no birth. Only positive different-principal
            // evidence excludes this process; same-owner and unknown stay busy.
            DaemonLease::Legacy(_) => {
                !matches!((owner, sid.as_deref()), (Some(owner), Some(sid)) if owner != sid)
            }
            _ => true,
        },
    }
}

pub fn unowned_daemon_is_stopping(state_dir: &Path) -> bool {
    let (lease, file) = read(state_dir);
    #[cfg(windows)]
    {
        let boot = crate::process::boot_id().ok();
        let owner = file.as_ref().and_then(super::lease_windows::file_owner);
        blocks(
            &lease,
            boot.as_deref(),
            owner.as_deref(),
            super::lease_windows::observe,
        )
    }
    #[cfg(not(windows))]
    {
        let _ = file;
        blocks(&lease, None, None, |_| ProcessFact::Unknown)
    }
}

#[cfg(test)]
#[path = "lease_tests.rs"]
mod tests;
