//! Restart only an authenticated native tray in its original interactive account.
use super::runtime::{runtime, system, wide, PIN};
use crate::updates::host::root;
use nessie_executor_updater::{catalog::UpdateResult, storage::Store};
use nessie_windows_common::{
    custody::Generation, custody_observation::absent, process::{self, Owned, Process},
    update_admission::Admission,
};
use serde::{Deserialize, Serialize};
use std::{ffi::OsStr, mem::size_of};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    Security::{GetTokenInformation, TokenUser, TOKEN_USER},
    System::{
        Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock},
        Pipes::GetNamedPipeClientProcessId,
        RemoteDesktop::WTSQueryUserToken,
        Threading::{CreateProcessAsUserW, TerminateProcess, CREATE_UNICODE_ENVIRONMENT,
            PROCESS_INFORMATION, STARTUPINFOW},
    },
};

const ERROR: &str = "update.application_restart_unavailable";
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Application {
    owner_sid: String,
    session: u32,
    original: Generation,
    launched: Option<Generation>,
    source_commit: Option<String>,
}
fn read(store: &Store) -> UpdateResult<Vec<Application>> {
    let applications: Vec<Application> = serde_json::from_value(store.applications()?).map_err(|_| ERROR)?;
    if applications.len() > 64 { return Err(ERROR); }
    Ok(applications)
}
fn save(store: &Store, value: &[Application]) -> UpdateResult<()> {
    store.save_applications(&serde_json::to_value(value).map_err(|_| ERROR)?)
}

pub(in crate::updates) fn prepare_exit(pipe: HANDLE, allowed: bool) -> UpdateResult<bool> {
    system()?;
    if !allowed { return Ok(false); }
    let _admission = Admission::acquire(true).map_err(|_| ERROR)?;
    let release = runtime()?;
    let mut pid = 0;
    if unsafe { GetNamedPipeClientProcessId(pipe, &mut pid) } == 0 { return Err(ERROR); }
    let caller = Process::open(pid).map_err(|_| ERROR)?;
    if !caller.alive() || caller.image != release.runtime.root.join("nessie-executor-tray.exe") {
        return Err(ERROR);
    }
    caller.signed(PIN).map_err(|_| ERROR)?;
    process::interactive(&caller).map_err(|_| ERROR)?;
    if !super::clearance::custody_idle()? || !super::clearance::ready(true)? { return Ok(false); }
    let store = Store::new(root()?);
    let mut applications = read(&store)?;
    if applications.iter().any(|app| app.original == caller.generation) { return Ok(true); }
    if let Some(app) = applications.iter_mut().find(|app| app.launched.as_ref() == Some(&caller.generation)) {
        app.original = caller.generation;
        app.launched = None;
        app.source_commit = None;
        save(&store, &applications)?;
        return Ok(true);
    }
    if applications.len() >= 64 { return Err(ERROR); }
    applications.push(Application { owner_sid: caller.sid, session: caller.session,
        original: caller.generation, launched: None, source_commit: None });
    save(&store, &applications)?;
    Ok(true)
}

fn token_sid(token: HANDLE) -> UpdateResult<String> {
    let mut length = 0;
    unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut length) };
    if length == 0 || length > 65_536 { return Err(ERROR); }
    let mut buffer = vec![0_usize; (length as usize).div_ceil(size_of::<usize>())];
    if unsafe { GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), length, &mut length) } == 0 {
        return Err(ERROR);
    }
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    nessie_windows_common::sid_to_string(user.User.Sid).ok_or(ERROR)
}

fn environment(token: HANDLE) -> UpdateResult<Vec<u16>> {
    let mut pointer = std::ptr::null_mut();
    if unsafe { CreateEnvironmentBlock(&mut pointer, token, 0) } == 0 { return Err(ERROR); }
    let result = (|| {
        let mut offset = 0;
        let mut filtered = Vec::new();
        while offset < 131_072 {
            let start = offset;
            while offset < 131_072 && unsafe { *pointer.cast::<u16>().add(offset) } != 0 { offset += 1; }
            if offset >= 131_072 { return Err(ERROR); }
            if start == offset { filtered.push(0); return Ok(filtered); }
            let entry = unsafe { std::slice::from_raw_parts(pointer.cast::<u16>().add(start), offset - start) };
            let text = String::from_utf16(entry).map_err(|_| ERROR)?;
            let key = text.split_once('=').map(|value| value.0.to_ascii_uppercase());
            if key.as_deref().is_some_and(|key| matches!(key, "USERPROFILE" | "APPDATA" | "LOCALAPPDATA"
                | "TEMP" | "TMP" | "HOMEDRIVE" | "HOMEPATH" | "USERNAME" | "USERDOMAIN"
                | "PATH" | "SYSTEMROOT" | "WINDIR")) {
                filtered.extend_from_slice(entry);
                filtered.push(0);
            }
            offset += 1;
        }
        Err(ERROR)
    })();
    unsafe { DestroyEnvironmentBlock(pointer) };
    result
}

fn launch(application: &Application, executable: &std::path::Path) -> UpdateResult<Generation> {
    if process::session_owner(application.session).map_err(|_| ERROR)? != application.owner_sid { return Err(ERROR); }
    let mut token = std::ptr::null_mut();
    if unsafe { WTSQueryUserToken(application.session, &mut token) } == 0 { return Err(ERROR); }
    let token = Owned(token);
    if token_sid(token.0)? != application.owner_sid { return Err(ERROR); }
    let mut environment = environment(token.0)?;
    let image = wide(executable.as_os_str());
    let mut arguments = wide(OsStr::new(&format!("\"{}\"", executable.display())));
    let mut desktop = wide(OsStr::new("winsta0\\default"));
    let directory = wide(executable.parent().ok_or(ERROR)?.as_os_str());
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    startup.lpDesktop = desktop.as_mut_ptr();
    let mut created: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { CreateProcessAsUserW(token.0, image.as_ptr(), arguments.as_mut_ptr(), std::ptr::null(),
        std::ptr::null(), 0, CREATE_UNICODE_ENVIRONMENT, environment.as_mut_ptr().cast(),
        directory.as_ptr(), &startup, &mut created) } == 0 { return Err(ERROR); }
    let handle = Owned(created.hProcess);
    unsafe { CloseHandle(created.hThread) };
    let process = Process::open(created.dwProcessId).map_err(|_| ERROR)?;
    if !process.alive() || process.sid != application.owner_sid || process.session != application.session
        || process.elevated || process.image != executable {
        unsafe { TerminateProcess(handle.0, 1) };
        return Err(ERROR);
    }
    process.signed(PIN).map_err(|_| ERROR)?;
    Ok(process.generation)
}

/// Invoked after replacement admits the new release, or after a local opt-out.
/// A logged-out session remains pending; it never redirects into another account.
pub(in crate::updates) fn resume(cancelled: bool) -> UpdateResult<()> {
    system()?;
    let _admission = Admission::acquire(true).map_err(|_| ERROR)?;
    let store = Store::new(root()?);
    let mut applications = read(&store)?;
    if applications.is_empty() { return Ok(()); }
    let release = runtime()?;
    let source = release.source_commit.as_deref().ok_or(ERROR)?;
    let mut changed = false;
    for app in &mut applications {
        if !absent(&app.original).map_err(|_| ERROR)? { continue; }
        if let Some(generation) = &app.launched {
            if !absent(generation).map_err(|_| ERROR)? {
                // An application from a superseded target is left running;
                // its own next drain will request another observed restart.
                continue;
            }
        }
        if let Ok(generation) = launch(app, &release.runtime.root.join("nessie-executor-tray.exe")) {
            app.launched = Some(generation);
            app.source_commit = Some(source.to_owned());
            changed = true;
        }
    }
    if cancelled {
        let prior = applications.len();
        applications.retain(|app| app.launched.as_ref().is_none_or(|generation|
            absent(generation) != Ok(false) || app.source_commit.as_deref() != Some(source)));
        changed |= prior != applications.len();
    }
    if changed { save(&store, &applications)?; }
    Ok(())
}

pub(super) fn confirmed(source: &str) -> UpdateResult<bool> {
    let store = Store::new(root()?);
    for app in read(&store)? {
        if !absent(&app.original).map_err(|_| ERROR)? { return Ok(false); }
        let Some(generation) = app.launched else { return Ok(false); };
        if app.source_commit.as_deref() != Some(source) || absent(&generation).map_err(|_| ERROR)? { return Ok(false); }
    }
    Ok(true)
}

pub(super) fn complete() -> UpdateResult<()> {
    Store::new(root()?).save_applications(&serde_json::json!([]))
}
