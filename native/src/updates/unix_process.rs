//! Updater inventory uses kernel process generations across local accounts.
use nessie_executor_updater::catalog::UpdateResult;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const ERROR: &str = "update.custody_unverified";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Process {
    pub pid: i32,
    pub parent: i32,
    pub uid: u32,
    pub started_at: String,
    pub executable: PathBuf,
}
fn relevant(name: &str) -> bool {
    name.to_ascii_lowercase().starts_with("nessie")
        || matches!(name, "node" | "nodejs" | "firecracker" | "jailer")
}

#[cfg(target_os = "linux")]
pub(super) fn information(pid: i32) -> UpdateResult<Option<Process>> {
    use std::{fs, os::unix::fs::MetadataExt};
    if pid <= 0 { return Err(ERROR); }
    let root = PathBuf::from(format!("/proc/{pid}"));
    let stat = match fs::read_to_string(root.join("stat")) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ERROR),
    };
    if stat.len() > 16_384 { return Err(ERROR); }
    let fields: Vec<_> = stat.rsplit_once(')').ok_or(ERROR)?.1.split_whitespace().collect();
    if fields.first() == Some(&"Z") { return Ok(None); }
    let parent = fields.get(1).ok_or(ERROR)?.parse().map_err(|_| ERROR)?;
    let started_at = fields.get(19).ok_or(ERROR)?.to_string();
    let uid = fs::metadata(&root).map_err(|_| ERROR)?.uid();
    let executable = match fs::read_link(root.join("exe")) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ERROR),
    };
    if !executable.is_absolute() { return Err(ERROR); }
    let current = crate::kernel_context::birth(pid).map_err(|_| ERROR)?;
    if current != started_at { return Err(ERROR); }
    Ok(Some(Process { pid, parent, uid, started_at, executable }))
}

#[cfg(target_os = "macos")]
pub(super) fn information(pid: i32) -> UpdateResult<Option<Process>> {
    crate::macos_processes::information(pid).map_err(|_| ERROR).map(|value| value.and_then(|value| {
        if value.zombie { None } else { Some(Process { pid, parent: value.parent_pid, uid: value.uid,
            started_at: value.started_at, executable: value.executable }) }
    }))
}

#[cfg(target_os = "linux")]
pub(super) fn products() -> UpdateResult<Vec<Process>> {
    use std::fs;
    let mut found = Vec::new();
    for entry in fs::read_dir("/proc").map_err(|_| ERROR)? {
        let entry = entry.map_err(|_| ERROR)?;
        let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<i32>().ok()) else { continue; };
        let stat = match fs::read_to_string(entry.path().join("stat")) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(ERROR),
        };
        let name = stat.split_once('(').and_then(|(_, rest)| rest.rsplit_once(')').map(|(name, _)| name)).ok_or(ERROR)?;
        if relevant(name) {
            if let Some(value) = information(pid)? { found.push(value); }
        }
    }
    Ok(found)
}

#[cfg(target_os = "macos")]
pub(super) fn products() -> UpdateResult<Vec<Process>> {
    extern "C" { fn proc_listpids(kind: u32, info: u32, buffer: *mut libc::c_void, size: i32) -> i32; }
    let mut pids = vec![0_i32; 65_536];
    let capacity = (pids.len() * std::mem::size_of::<i32>()) as i32;
    let count = unsafe { proc_listpids(1, 0, pids.as_mut_ptr().cast(), capacity) };
    if count <= 0 || count >= capacity || count % 4 != 0 { return Err(ERROR); }
    let mut found = Vec::new();
    for pid in pids.into_iter().take(count as usize / 4).filter(|pid| *pid > 0) {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        if unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size) } != size {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) { continue; }
            return Err(ERROR);
        }
        let info = unsafe { info.assume_init() };
        let name = unsafe { std::ffi::CStr::from_ptr(info.pbi_comm.as_ptr().cast()) }.to_str().map_err(|_| ERROR)?;
        if relevant(name) {
            if let Some(value) = information(pid)? { found.push(value); }
        }
    }
    Ok(found)
}

pub(super) fn same_generation(value: &Process) -> UpdateResult<bool> {
    Ok(information(value.pid)?.is_some_and(|current| current == *value))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_real_process_generation_is_stable_and_a_forged_birth_does_not_match() {
        let own = information(std::process::id() as i32).unwrap().unwrap();
        assert!(same_generation(&own).unwrap());
        let mut stale = own;
        stale.started_at = "0".into();
        assert!(!same_generation(&stale).unwrap());
    }
}
