//! Upgrade-only recovery of PID-only lifecycle files owned by an observed app user.
//! The installer already runs as SYSTEM. No live app receives extra privileges.
use crate::lease::{self, DaemonLease, ProcessFact};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::Path,
};
use windows_sys::Win32::{
    Foundation::{GENERIC_READ, HANDLE},
    Storage::FileSystem::{
        FileDispositionInfo, SetFileInformationByHandle, DELETE, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_DISPOSITION_INFO, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
    },
};

fn real_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|value| {
        value.is_dir() && value.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
    })
}

/// The profile and SID came from a held, unelevated app process before handover.
/// Call only after that install's old processes have drained. No other files,
/// credentials, permissions, sessions or commands are read or changed.
pub(super) fn retire(profile: &Path, owner: &str) {
    if crate::process::Process::open(std::process::id())
        .map_or(true, |process| process.sid != "S-1-5-18")
    {
        return;
    }
    if !real_directory(profile) {
        return;
    }
    let mut root = profile.to_path_buf();
    for segment in [".local", "state", "nessie-executor"] {
        root.push(segment);
        if !real_directory(&root) {
            return;
        }
    }
    let _ = retire_file(
        &root.join("pairing-activation.pid"),
        owner,
        crate::lease_windows::observe,
    );
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.take(4096).filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !lease::uuid(&name) || !real_directory(&entry.path()) {
            continue;
        }
        for name in ["daemon.pid", "pairing-operation.pid"] {
            let _ = retire_file(
                &entry.path().join(name),
                owner,
                crate::lease_windows::observe,
            );
        }
    }
}

fn retire_file(path: &Path, owner: &str, observe: impl FnOnce(u32) -> ProcessFact) -> bool {
    // Deny writes and deletion while observing. Delete the held file itself,
    // never a pathname that another reclaimer could replace after inspection.
    let Ok(file) = OpenOptions::new()
        .access_mode(GENERIC_READ | DELETE)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
    else {
        return false;
    };
    retire_held(&file, owner, observe)
}

fn retire_held(file: &File, owner: &str, observe: impl FnOnce(u32) -> ProcessFact) -> bool {
    let Ok(meta) = file.metadata() else {
        return false;
    };
    if !meta.is_file()
        || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || meta.len() > 4096
        || crate::lease_windows::file_owner_sid(file).as_deref() != Some(owner)
    {
        return false;
    }
    let mut bytes = Vec::new();
    if file.take(4097).read_to_end(&mut bytes).is_err() || bytes.len() > 4096 {
        return false;
    }
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return false;
    };
    let DaemonLease::Legacy(pid) = lease::parse(text) else {
        return false;
    };
    let absent = match observe(pid) {
        ProcessFact::Absent => true,
        ProcessFact::Present { sid: Some(sid), .. } => sid != owner,
        _ => false,
    };
    if !absent {
        return false;
    }
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle() as HANDLE,
            FileDispositionInfo,
            (&disposition as *const FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        ) != 0
    }
}

#[cfg(test)]
#[path = "lease_upgrade_tests.rs"]
mod tests;
