//! Public native creation journals and independent all-account kernel clearance.
use super::{unix_process::{self, Process}, unix_runtime};
use crate::managed_runtime::Record;
use nessie_executor_updater::catalog::UpdateResult;
use std::{ffi::CStr, fs::{self, OpenOptions}, os::unix::fs::{MetadataExt, OpenOptionsExt}, path::{Path, PathBuf}};

const ERROR: &str = "update.custody_unverified";
pub(crate) fn activity(arguments: &[String]) -> Option<String> {
    arguments.first().filter(|argument| matches!(argument.as_str(),
        "serve" | "serve-direct-local-inference" | "personal-chatgpt-credential")).cloned()
}

/// Only account metadata and public native process records are read. Provider
/// profiles, pairing files, credentials and the custody guard remain untouched.
pub(super) fn roots() -> UpdateResult<Vec<(u32, PathBuf)>> {
    unix_runtime::privileged()?;
    // getpwent owns global state; a broker can inspect health on several threads.
    static ACCOUNTS: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _accounts = ACCOUNTS.lock().map_err(|_| ERROR)?;
    let mut roots = vec![(0, PathBuf::from(crate::managed_machine_barrier::ROOT_RUNTIME))];
    unsafe { libc::setpwent(); }
    let result = (|| {
        loop {
            unsafe { *crate::unix_kernel::errno_address() = 0; }
            let entry = unsafe { libc::getpwent() };
            if entry.is_null() {
                if unsafe { *crate::unix_kernel::errno_address() } != 0 { return Err(ERROR); }
                break;
            }
            if roots.len() > 4096 { return Err(ERROR); }
            let uid = unsafe { (*entry).pw_uid };
            if uid == 0 { continue; }
            let home = PathBuf::from(unsafe { CStr::from_ptr((*entry).pw_dir) }.to_str().map_err(|_| ERROR)?);
            if !home.is_absolute() { return Err(ERROR); }
            let metadata = match fs::symlink_metadata(&home) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(ERROR),
            };
            if metadata.uid() != uid { continue; }
            if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.mode() & 0o022 != 0 {
                return Err(ERROR);
            }
            let root = home.join(".nessie/personal-inference");
            if !roots.contains(&(uid, root.clone())) { roots.push((uid, root)); }
        }
        Ok(roots)
    })();
    unsafe { libc::endpwent(); }
    result
}

pub(super) fn records(uid: u32, root: &Path) -> UpdateResult<Vec<Record>> {
    // Refuse a symlink at either private ancestor before opening a journal.
    for directory in [root.parent().ok_or(ERROR)?, root] {
        match fs::symlink_metadata(directory) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink()
                && metadata.uid() == uid && metadata.mode() & 0o022 == 0 => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            _ => return Err(ERROR),
        }
    }
    let directory = root.join("managed-runtimes");
    let metadata = match fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(ERROR),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.uid() != uid || metadata.mode() & 0o022 != 0 {
        return Err(ERROR);
    }
    let boot = crate::managed_runtime_context::boot_id().map_err(|_| ERROR)?;
    let mut records = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|_| ERROR)? {
        let path = entry.map_err(|_| ERROR)?.path();
        let name = path.file_name().and_then(|name| name.to_str()).ok_or(ERROR)?;
        if name.ends_with(".sock") { continue; }
        if !name.ends_with(".json") && !name.ends_with(".draft") { return Err(ERROR); }
        let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&path).map_err(|_| ERROR)?;
        let metadata = file.metadata().map_err(|_| ERROR)?;
        if !metadata.is_file() || metadata.uid() != uid || metadata.nlink() != 1
            || metadata.mode() & (if uid == 0 { 0o022 } else { 0o077 }) != 0 || metadata.len() > 8192 { return Err(ERROR); }
        if name.ends_with(".draft") {
            // An incomplete current-boot publication may retain a gated child.
            if !name.starts_with(&format!("{}_", &boot[..8])) { continue; }
            return Err(ERROR);
        }
        let record: Record = serde_json::from_reader(file).map_err(|_| ERROR)?;
        if !crate::managed_runtime_context::valid_boot_id(&record.boot_id) || record.protocol_version != 1
            || record.guard_version != crate::managed_release::GUARD_VERSION || record.supervisor_pid <= 0
            || record.child_pid <= 0 || record.release_digest.len() != 64 { return Err(ERROR); }
        if record.boot_id == boot { records.push(record); }
        if records.len() > 4096 { return Err(ERROR); }
    }
    Ok(records)
}

fn allowed(process: &Process) -> UpdateResult<bool> {
    if process.executable.file_name().and_then(|name| name.to_str()) == Some("nessie-computer-updater") {
        if process.uid != 0 { return Err(ERROR); }
        let _pin = unix_runtime::pin_worker(&process.executable)?;
        return Ok(true);
    }
    #[cfg(target_os = "macos")]
    if ["/Applications/Nessie.app/Contents/MacOS/Nessie", "/Applications/Nessie Desktop.app/Contents/MacOS/Nessie"]
        .iter().any(|path| process.executable == Path::new(path)) {
        let app = process.executable.parent().and_then(Path::parent).and_then(Path::parent).ok_or(ERROR)?;
        crate::macos_provenance::require_independent_app(app).map_err(|_| ERROR)?;
        return Ok(true);
    }
    // All runtimes, credential actors, native parents and sandbox processes
    // must leave naturally. The menu app also exits before its package changes.
    Ok(false)
}

/// MachineBarrier is retained by the caller. Never prune records to get clear.
pub(super) fn ready() -> UpdateResult<bool> {
    for (uid, root) in roots()? {
        if !records(uid, &root)?.is_empty() { return Ok(false); }
    }
    let mut initial = unix_process::products()?;
    initial.sort_by_key(|process| process.pid);
    for process in &initial {
        if !allowed(process)? { return Ok(false); }
        if !unix_process::same_generation(process)? { return Ok(false); }
    }
    let mut second = unix_process::products()?;
    second.sort_by_key(|process| process.pid);
    Ok(initial == second)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_fixed_native_command_arguments_mark_long_lived_actors() {
        assert_eq!(activity(&["serve".into()]), Some("serve".into()));
        assert_eq!(activity(&["serve-direct-local-inference".into()]), Some("serve-direct-local-inference".into()));
        assert_eq!(activity(&["updates".into(), "serve".into()]), None);
        assert_eq!(activity(&[]), None);
    }
}
