//! What runs from the install folder is closed before Windows Installer
//! changes its files, and the Windows app is reopened after.
//!
//! The installer stops the service, and the service stops the teams it runs.
//! Everything else started from the folder kept the old files in use: the
//! Windows app in each person's session, the team daemons it runs, and any a
//! scheduled task or a terminal runs. The installer replaced files anyway,
//! failed with 1603, and its rollback queued file swaps for the next restart
//! that undid the following install.
//!
//! Closing is graceful first. A Windows app from this version or later quits
//! when the install event is set ([`INSTALL_EVENT`]); its daemons then see
//! their liveness pipe close and stop on their own. Any other daemon is sent
//! Ctrl+Break on its own hidden console, which a daemon from this version
//! treats as a request to stop. What still runs when the grace period ends is
//! terminated, because leaving it running guarantees the failed install.

use crate::{
    custody::REJECTED,
    process::{self, Owned, Process},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    path::Path,
    time::{Duration, Instant},
};

/// Set while an installer is about to change the files; the Windows app quits when it sees it.
pub const INSTALL_EVENT: &str = r"Global\NessieComputerInstall";

pub const TRAY: &str = "nessie-executor-tray.exe";
const SERVICE: &str = "nessie-executor-service.exe";
const RUNTIME: &str = "nessie-executor-runtime.exe";
/// Every program a team or the app runs from the install folder.
const IMAGES: [&str; 4] = [TRAY, RUNTIME, "nessie-executor-native.exe", "nessie-hyperv-bridge.exe"];

/// A Windows app that was open, to reopen in the same session for the same person.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenApp {
    pub owner_sid: String,
    pub session: u32,
}

/// What closing did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Closing {
    pub apps: Vec<OpenApp>,
    /// Processes that stopped when asked.
    pub stopped: usize,
    /// Processes still running when their grace period ended, then terminated.
    pub terminated: usize,
}

/// Whether `image` lies inside `folder`, compared component by component and
/// ignoring only ASCII case, as Windows paths compare.
pub fn inside(image: &Path, folder: &Path) -> bool {
    let folder: Vec<_> = folder.components().collect();
    let image: Vec<_> = image.components().collect();
    image.len() > folder.len()
        && folder.iter().zip(&image).all(|(folder, image)| folder.as_os_str().eq_ignore_ascii_case(image.as_os_str()))
}

/// The processes to leave alone: every service process and its descendants,
/// which the installer stops by stopping the service.
pub fn service_tree(entries: &[(u32, u32, String)]) -> BTreeSet<u32> {
    let mut tree: BTreeSet<u32> = entries.iter()
        .filter(|(_, _, name)| name.eq_ignore_ascii_case(SERVICE)).map(|(pid, _, _)| *pid).collect();
    loop {
        let before = tree.len();
        for (pid, parent, _) in entries {
            if *pid != *parent && tree.contains(parent) {
                tree.insert(*pid);
            }
        }
        if tree.len() == before {
            return tree;
        }
    }
}

/// The candidates by name, outside the service's tree.
pub fn candidates(entries: &[(u32, u32, String)]) -> Vec<(u32, String)> {
    let service = service_tree(entries);
    entries.iter()
        .filter(|(pid, _, name)| !service.contains(pid) && IMAGES.iter().any(|image| name.eq_ignore_ascii_case(image)))
        .map(|(pid, _, name)| (*pid, name.to_ascii_lowercase()))
        .collect()
}

/// Every process from the install folder that is not the service's.
pub fn running_from(folder: &Path) -> Result<Vec<(Process, String)>, String> {
    let entries: Vec<(u32, u32, String)> = process::snapshot()?
        .into_iter().map(|entry| (entry.pid, entry.parent, entry.name)).collect();
    Ok(candidates(&entries).into_iter()
        .filter_map(|(pid, name)| Process::open(pid).ok().map(|process| (process, name)))
        .filter(|(process, _)| process.alive() && inside(&process.image, folder))
        .collect())
}

/// Closes everything that runs from `folder` and is not the service's.
/// `grace` bounds the whole wait; the apps get a fifth of it to quit on their
/// own. Refuses only when something still runs after being terminated.
pub fn close(folder: &Path, grace: Duration) -> Result<Closing, String> {
    close_found(running_from(folder)?, grace, true)
}

/// `announce` sets the install event; a test leaves it alone, or it would
/// close the Windows app of whoever runs the test.
fn close_found(found: Vec<(Process, String)>, grace: Duration, announce: bool) -> Result<Closing, String> {
    let mut closing = Closing {
        apps: found.iter().filter(|(_, name)| name == TRAY)
            .map(|(process, _)| OpenApp { owner_sid: process.sid.clone(), session: process.session }).collect(),
        ..Closing::default()
    };
    let started = Instant::now();
    let _event = announce.then(signal_install).flatten();
    let ours: BTreeSet<u32> = found.iter().map(|(process, _)| process.generation.pid).collect();
    for (process, name) in &found {
        if name == RUNTIME {
            break_console(process.generation.pid, &ours);
        }
    }
    let (apps, rest): (Vec<_>, Vec<_>) = found.into_iter().partition(|(_, name)| name == TRAY);
    for group in [(apps, grace / 5), (rest, grace)] {
        let (processes, limit) = group;
        for (process, _) in processes {
            let left = limit.saturating_sub(started.elapsed());
            if wait(&process, left) {
                closing.stopped += 1;
            } else {
                terminate(process.generation.pid);
                if !wait(&process, Duration::from_secs(5)) {
                    return Err(REJECTED.into());
                }
                closing.terminated += 1;
            }
        }
    }
    Ok(closing)
}

fn wait(process: &Process, limit: Duration) -> bool {
    use windows_sys::Win32::{Foundation::WAIT_OBJECT_0, System::Threading::WaitForSingleObject};
    let milliseconds = u32::try_from(limit.as_millis()).unwrap_or(u32::MAX);
    unsafe { WaitForSingleObject(process.handle.0, milliseconds) == WAIT_OBJECT_0 }
}

fn terminate(pid: u32) {
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
    if !handle.is_null() {
        let handle = Owned(handle);
        unsafe { TerminateProcess(handle.0, 1) };
    }
}

/// Sets the install event for as long as the returned handle lives. Anyone
/// signed in may wait on it; only an administrator or SYSTEM can set it.
fn signal_install() -> Option<Owned> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW, SECURITY_ATTRIBUTES},
        System::Threading::{CreateEventW, SetEvent},
    };
    let wide = |value: &str| OsStr::new(value).encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    // SYSTEM and administrators: all access; authenticated users: SYNCHRONIZE only.
    let sddl = wide("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x00100000;;;AU)");
    let mut descriptor = std::ptr::null_mut();
    if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, std::ptr::null_mut()) } == 0 {
        return None;
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let name = wide(INSTALL_EVENT);
    let event = unsafe { CreateEventW(&attributes, 1, 0, name.as_ptr()) };
    unsafe { LocalFree(descriptor) };
    if event.is_null() {
        return None;
    }
    let event = Owned(event);
    unsafe { SetEvent(event.0) };
    Some(event)
}

/// Whether an installer is about to change the files: the Windows app asks on each poll.
pub fn install_signalled() -> bool {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::{
        Foundation::WAIT_OBJECT_0,
        System::Threading::{OpenEventW, WaitForSingleObject, SYNCHRONIZATION_SYNCHRONIZE},
    };
    let name: Vec<u16> = OsStr::new(INSTALL_EVENT).encode_wide().chain(Some(0)).collect();
    let event = unsafe { OpenEventW(SYNCHRONIZATION_SYNCHRONIZE, 0, name.as_ptr()) };
    if event.is_null() {
        return false;
    }
    let event = Owned(event);
    unsafe { WaitForSingleObject(event.0, 0) == WAIT_OBJECT_0 }
}

/// Whether a console may be sent Ctrl+Break: every process attached to it is
/// one of ours (team processes from the install folder) or this one. A daemon
/// sharing a person's terminal is left to the grace period instead.
pub fn console_is_ours(attached: &[u32], ours: &BTreeSet<u32>, me: u32) -> bool {
    !attached.is_empty() && attached.iter().all(|pid| *pid == me || ours.contains(pid))
}

/// Ctrl+Break on the daemon's own hidden console (the launcher starts it with
/// `CREATE_NO_WINDOW`). This process ignores the event it sends itself.
fn break_console(pid: u32, ours: &BTreeSet<u32>) {
    use windows_sys::Win32::System::Console::{
        AttachConsole, FreeConsole, GenerateConsoleCtrlEvent, GetConsoleProcessList, SetConsoleCtrlHandler,
        CTRL_BREAK_EVENT,
    };
    unsafe extern "system" fn ignore(_event: u32) -> windows_sys::core::BOOL {
        1
    }
    unsafe {
        SetConsoleCtrlHandler(Some(ignore), 1);
        FreeConsole();
        if AttachConsole(pid) == 0 {
            return;
        }
        let mut attached = [0_u32; 64];
        let count = GetConsoleProcessList(attached.as_mut_ptr(), attached.len() as u32) as usize;
        if count <= attached.len() && console_is_ours(&attached[..count], ours, std::process::id()) {
            GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, 0);
        }
        FreeConsole();
    }
}

/// Reopens each Windows app that was open, in its own session, for the person
/// signed in there; an app whose person has signed out stays closed.
pub fn reopen(apps: &[OpenApp], folder: &Path, pin: Option<&str>) -> usize {
    let executable = folder.join(TRAY);
    let mut seen = BTreeSet::new();
    apps.iter()
        .filter(|app| seen.insert((app.owner_sid.clone(), app.session)))
        .filter(|app| crate::session_launch::launch_app(&app.owner_sid, app.session, &executable, pin).is_ok())
        .count()
}

#[cfg(test)]
#[path = "install_handover_tests.rs"]
mod tests;
