//! A retained same-user native agent reopens the verified menu app after replacement.
use super::{admission_unix, host::root, unix_clearance, unix_health, unix_process::{self, Process}, unix_runtime::{self, ERROR}};
use nessie_executor_updater::{catalog::{self, UpdateResult}, protocol::Phase, storage::Store};
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, os::unix::net::UnixStream, path::{Path, PathBuf}, process::{Command, Stdio}, time::Duration};

const APPLICATION: &str = "/Applications/Nessie Executor.app";
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    transaction: String,
    target_source: String,
    application: Process,
    agent: Process,
    resumed: Option<Process>,
}
fn plans() -> UpdateResult<Vec<Plan>> {
    serde_json::from_value(Store::new(root()?).applications()?).map_err(|_| ERROR)
}
fn save(plans: &[Plan]) -> UpdateResult<()> {
    Store::new(root()?).save_applications(&serde_json::to_value(plans).map_err(|_| ERROR)?)
}
fn application(process: &Process) -> UpdateResult<Option<PathBuf>> {
    let Some(app) = process.executable.parent().and_then(Path::parent).and_then(Path::parent) else { return Ok(None); };
    let allowed = [PathBuf::from(APPLICATION),
        PathBuf::from("/Applications/Nessie.app/Contents/Library/LoginItems/Nessie Executor.app"),
        PathBuf::from("/Applications/Nessie Desktop.app/Contents/Library/LoginItems/Nessie Executor.app")];
    if !allowed.contains(&app.to_path_buf()) || process.executable.file_name().and_then(|name| name.to_str()) != Some("Nessie Executor") {
        return Ok(None);
    }
    crate::macos_provenance::require_independent_app(app).map_err(|_| ERROR)?;
    Ok(Some(app.to_path_buf()))
}
fn app_source(app: &Path) -> UpdateResult<String> {
    crate::macos_provenance::require_independent_app(app).map_err(|_| ERROR)?;
    let bytes = fs::read(app.join("Contents/Resources/executor-runtime/manifest.json")).map_err(|_| ERROR)?;
    if bytes.len() > 65_536 { return Err(ERROR); }
    let manifest: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
    let source = manifest["executorSourceCommit"].as_str().ok_or(ERROR)?;
    if source.len() != 40 || !source.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err(ERROR); }
    crate::macos_provenance::require_independent_app(app).map_err(|_| ERROR)?;
    Ok(source.into())
}

pub(super) fn allowed(process: &Process, menu_apps: bool) -> UpdateResult<bool> {
    if plans()?.iter().any(|plan| plan.agent == *process) { return Ok(true); }
    Ok(menu_apps && application(process)?.is_some())
}

/// A fixed RPC, available only to the signed native child of the running menu
/// app. It accepts no path, user id, executable or caller-supplied generation.
pub(super) fn wait(stream: &UnixStream) -> UpdateResult<serde_json::Value> {
    unix_runtime::privileged()?;
    let caller = unix_health::peer(stream)?;
    if caller.uid == 0 { return Err(ERROR); }
    let _barrier = crate::managed_machine_barrier::MachineBarrier::acquire().map_err(|_| "update.admission_busy")?;
    let store = Store::new(root()?);
    let mut entries = plans()?;
    if let Some(plan) = entries.iter().find(|plan| plan.agent == caller) {
        let maintenance = admission_unix::read()?;
        let current = crate::managed_release::installed().ok();
        let may_open = current.as_ref().is_some_and(|release| !maintenance.draining
            || maintenance.restart_ready && release.source_commit.as_deref() == Some(&plan.target_source));
        let source = current.and_then(|release| release.source_commit);
        return Ok(serde_json::json!({"mayExit":true,"mayOpen":may_open && source.is_some()
            && app_source(Path::new(APPLICATION)).ok() == source}));
    }
    let release = crate::managed_release::installed().map_err(|_| ERROR)?;
    if caller.executable != release.directory.join("nessie-executor-native") { return Err(ERROR); }
    crate::macos_provenance::require_process(caller.pid).map_err(|_| ERROR)?;
    let parent = unix_process::information(caller.parent)?.ok_or(ERROR)?;
    if parent.uid != caller.uid || application(&parent)?.is_none() { return Err(ERROR); }
    let pending = store.journal()?.pending.ok_or(ERROR)?;
    if pending.phase != Phase::Waiting || !admission_unix::read()?.draining { return Err(ERROR); }
    if !unix_clearance::ready_with(true, Some(&caller))? {
        return Ok(serde_json::json!({"mayExit":false,"mayOpen":false}));
    }
    let accepted = catalog::verify_manifest(&pending.envelope, &catalog::release_key()?, pending.started_at as i64,
        pending.channel, None)?;
    if accepted.digest != pending.digest || !unix_process::same_generation(&caller)?
        || !unix_process::same_generation(&parent)? { return Err(ERROR); }
    entries.push(Plan { transaction:pending.digest, target_source:accepted.manifest.source_commit,
        application:parent, agent:caller, resumed:None });
    save(&entries)?;
    Ok(serde_json::json!({"mayExit":true,"mayOpen":false}))
}

/// The new app's ordinary status client supplies kernel-observed parentage;
/// a version claim from JavaScript cannot complete the restart record.
pub(super) fn observe(stream: &UnixStream) -> UpdateResult<()> {
    // Ordinary Settings probes cannot complete a restart that was never
    // requested. Avoid verifying a whole app for that unrelated observation.
    if plans()?.is_empty() { return Ok(()); }
    let caller = unix_health::peer(stream)?;
    let release = crate::managed_release::installed().map_err(|_| ERROR)?;
    if caller.executable != release.directory.join("nessie-executor-native") { return Err(ERROR); }
    let parent = unix_process::information(caller.parent)?.ok_or(ERROR)?;
    if parent.uid != caller.uid { return Err(ERROR); }
    let Some(app) = application(&parent)? else { return Ok(()); };
    if app != Path::new(APPLICATION) || app_source(&app)?.as_str() != release.source_commit.as_deref().ok_or(ERROR)? { return Err(ERROR); }
    let _barrier = crate::managed_machine_barrier::MachineBarrier::acquire().map_err(|_| "update.admission_busy")?;
    let mut entries = plans()?;
    for plan in &mut entries {
        if plan.application.uid == parent.uid && plan.application != parent { plan.resumed = Some(parent.clone()); }
    }
    save(&entries)
}

pub(super) fn confirmed(source: &str) -> UpdateResult<bool> {
    for plan in plans()?.iter().filter(|plan| plan.target_source == source) {
        let Some(process) = &plan.resumed else { return Ok(false); };
        if !unix_process::same_generation(process)? || app_source(Path::new(APPLICATION))? != source { return Ok(false); }
    }
    Ok(true)
}
pub(super) fn complete() -> UpdateResult<()> { save(&[]) }

pub(super) fn reopen() -> Result<(), String> {
    if unsafe { libc::getuid() } == 0 || unsafe { libc::geteuid() } == 0 { return Err(ERROR.into()); }
    let original_parent = unsafe { libc::getppid() };
    if unsafe { libc::setsid() } < 0 { return Err(ERROR.into()); }
    let mut announced = false;
    loop {
        if !announced && unsafe { libc::getppid() } != original_parent { return Err(ERROR.into()); }
        if let Ok(value) = super::channel::call_value(&serde_json::json!({"operation":"application_wait"})) {
            if value["mayExit"] == true && !announced {
                println!("{{\"ready\":true}}");
                std::io::stdout().flush().map_err(|_| ERROR)?;
                announced = true;
            }
            if announced && value["mayOpen"] == true {
                crate::macos_provenance::require_independent_app(Path::new(APPLICATION)).map_err(|_| ERROR)?;
                let success = Command::new("/usr/bin/open").args(["-a", APPLICATION]).env_clear()
                    .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin").current_dir("/")
                    .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_| ERROR)?;
                if success.success() { return Ok(()); }
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}
