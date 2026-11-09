//! Restart only an authenticated native tray in its original interactive account.
use super::runtime::{runtime, system, PIN};
use crate::updates::host::root;
use nessie_executor_updater::{catalog::UpdateResult, storage::Store};
use nessie_windows_common::{
    custody::Generation, custody_observation::absent, process::{self, Process},
    update_admission::Admission,
};
use serde::{Deserialize, Serialize};
use windows_sys::Win32::{Foundation::HANDLE, System::Pipes::GetNamedPipeClientProcessId};

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

fn launch(application: &Application, executable: &std::path::Path) -> UpdateResult<Generation> {
    nessie_windows_common::session_launch::launch_app(&application.owner_sid, application.session, executable, PIN)
        .map_err(|_| ERROR)
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
