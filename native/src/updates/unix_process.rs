//! Updater inventory uses kernel process generations across local accounts.
//! `products` lists the processes running Nessie Computer's installed files.
use nessie_executor_updater::catalog::UpdateResult;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

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
    Ok(holders(found))
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
    Ok(holders(found))
}

/// Directories holding Nessie Computer's own installed executables: the
/// protected releases, root runtime and updater worker, the app bundles a swap
/// replaces and the older Homebrew and menu bar installs.
#[cfg(target_os = "macos")]
const INSTALLED: [&str; 7] = [
    "/Library/Application Support/Nessie Executor",
    super::macos_bundle::APPLICATIONS[0],
    super::macos_bundle::APPLICATIONS[1],
    super::macos_bundle::APPLICATIONS[2],
    "/Applications/NessieExecutorMenuBar.app",
    "/opt/homebrew/Cellar/nessie-executor",
    "/usr/local/Cellar/nessie-executor",
];
#[cfg(target_os = "linux")]
const INSTALLED: [&str; 3] = ["/usr/lib/nessie-executor", "/usr/libexec/nessie-executor-updater", "/var/lib/nessie-executor"];

fn installed(executable: &Path) -> bool {
    INSTALLED.iter().any(|root| {
        let mut parts = executable.components();
        // The Mac's system volume does not distinguish case; Linux does.
        Path::new(root).components().all(|expected| parts.next().is_some_and(|part| if cfg!(target_os = "macos") {
            part.as_os_str().eq_ignore_ascii_case(expected.as_os_str())
        } else { part == expected }))
    })
}

/// A name only nominates a candidate. A process holds the swap when it runs an
/// installed executable, or is a Node that such a process started. Nessie
/// Desktop, dictation apps and development builds elsewhere share the name,
/// not the files, so they never hold it.
fn holders(candidates: Vec<Process>) -> Vec<Process> {
    let held = |process: &Process| installed(&process.executable) || matches!(process.executable.file_name()
        .and_then(|name| name.to_str()), Some("node" | "nodejs"))
        && candidates.iter().any(|parent| parent.pid == process.parent && installed(&parent.executable));
    candidates.iter().filter(|process| held(process)).cloned().collect()
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

    fn process(pid: i32, parent: i32, executable: &str) -> Process {
        Process { pid, parent, uid: 501, started_at: "1".into(), executable: executable.into() }
    }
    fn held(candidates: Vec<Process>) -> Vec<i32> {
        holders(candidates).into_iter().map(|process| process.pid).collect()
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unrelated_nessie_named_programs_never_hold_the_swap() {
        // On 16 November these kept dictator's 1.1.13 swap waiting for about
        // 50 minutes: Nessie Desktop, a dictation dev build and a simulator app.
        assert!(held(vec![
            process(10, 1, "/Applications/Nessie.app/Contents/MacOS/nessie-desktop"),
            process(11, 1, "/Applications/Nessie Desktop.app/Contents/MacOS/nessie-desktop"),
            process(12, 1, "/Users/dictator/Projects/nessie-dictation/target/debug/nessie-dictation-app"),
            process(13, 1, "/Users/dictator/Library/Developer/CoreSimulator/Devices/A/data/Containers/Bundle/Application/B/NessieDictation.app/NessieDictation"),
            process(14, 1, "/Users/dictator/Projects/nessie-computer/native/target/debug/nessie-executor-native"),
            // Desktop's own helpers and the Node they start are not ours either.
            process(15, 10, "/Applications/Nessie.app/Contents/Resources/executor-runtime/node"),
            process(16, 10, "/opt/homebrew/bin/node"),
        ]).is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn processes_running_installed_executables_still_hold_the_swap() {
        let release = "/Library/Application Support/Nessie Executor/releases/3629";
        assert_eq!(held(vec![
            process(20, 1, &format!("{release}/nessie-executor-native")),
            process(21, 20, &format!("{release}/nessie-executor-runtime")),
            process(22, 1, "/Library/Application Support/Nessie Executor/updates/bin/7d04/nessie-computer-updater"),
            process(23, 1, "/Applications/Nessie Executor.app/Contents/MacOS/Nessie Executor"),
            // A daemon started by hand from the app bundle, outside custody.
            process(24, 1, "/Applications/Nessie Executor.app/Contents/Resources/executor-runtime/nessie-executor-runtime"),
            process(25, 1, "/Applications/Nessie.app/Contents/Library/LoginItems/Nessie Executor.app/Contents/MacOS/Nessie Executor"),
            process(26, 1, "/opt/homebrew/Cellar/nessie-executor/1.0.3/libexec/runtime/nessie-executor-runtime"),
            // Any Node a product process starts waits too, wherever it lives.
            process(27, 21, "/opt/homebrew/bin/node"),
            // The kernel may report the case-insensitive volume's other spelling.
            process(28, 1, "/library/application support/nessie executor/releases/3629/nessie-executor-native"),
        ]), vec![20, 21, 22, 23, 24, 25, 26, 27, 28]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_holds_only_the_installed_release_and_updater() {
        assert_eq!(held(vec![
            process(30, 1, "/usr/lib/nessie-executor/releases/3629/nessie-executor-native"),
            process(31, 30, "/usr/lib/nessie-executor/releases/3629/resources/firecracker/firecracker"),
            process(32, 1, "/usr/libexec/nessie-executor-updater/7d04/nessie-computer-updater"),
            process(33, 30, "/usr/bin/node"),
            process(34, 1, "/opt/Nessie/nessie-desktop"),
            process(35, 1, "/home/umac/Projects/nessie-computer/native/target/debug/nessie-executor-native"),
            process(36, 34, "/usr/bin/node"),
            process(37, 1, "/usr/local/bin/firecracker"),
        ]), vec![30, 31, 32, 33]);
    }
}
