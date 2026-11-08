//! Entry point of the approved app-bundled service, before any Node can launch.
use super::{admission_unix, host::root, macos_bundle::{self, Bundle}, unix_runtime::{self, ERROR}};
use nessie_executor_updater::{catalog::UpdateResult, storage::Store};
use std::{fs, os::unix::process::CommandExt, path::Path, process::{Command, Stdio}, time::Duration};

const CURRENT: &str = "/Library/Application Support/Nessie Executor/current";

fn present(path: &Path) -> UpdateResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(ERROR),
    }
}

fn report(code: &str) {
    if let Ok(message) = std::ffi::CString::new(format!("Nessie update helper: {code}")) {
        unsafe { libc::syslog(libc::LOG_ERR, c"%s".as_ptr(), message.as_ptr()); }
    }
}

pub(super) fn run() -> UpdateResult<()> {
    let result = run_registered();
    if let Err(code) = result { report(code); }
    result
}

fn run_registered() -> UpdateResult<()> {
    Bundle::authorize_registered()?;
    crate::managed_machine_barrier::install().map_err(|_| ERROR)?;
    unix_runtime::directory(&root()?)?;
    let store = Store::new(root()?);
    if !store.installation_enabled()? { return Err("update.installation_removed"); }
    // An app update reaches an older installed factory only here. If the app's
    // runtime cannot be installed yet, the installed runtime serves as before.
    if unix_runtime::installed().is_ok() {
        if let Err(code) = super::macos_recovery::application_runtime(&store) { report(code); }
    }
    let has_pointer = present(Path::new(CURRENT))?;
    let has_worker = present(&root()?.join("worker.json"))?;
    // A partial accepted replacement belongs to the protected worker and its
    // journal. A surviving bundled helper must never reset it from its app.
    let recovering = has_worker || store.journal()?.pending.is_some();
    let image = if unix_runtime::installed().is_ok() {
        unix_runtime::initialize_selected()?
    } else if recovering {
        unix_runtime::worker_image()?
    } else {
        if has_pointer && crate::managed_release::installed().is_err() { return Err(ERROR); }
        let bundle = Bundle::registered()?;
        let process = super::unix_process::information(std::process::id() as i32)?.ok_or(ERROR)?;
        loop {
            let ready = {
                let _barrier = crate::managed_machine_barrier::MachineBarrier::acquire()
                    .map_err(|_| "update.admission_busy")?;
                let mut maintenance = admission_unix::read()?;
                maintenance.draining = true;
                maintenance.restart_ready = false;
                admission_unix::write(&maintenance)?;
                store.mutate_journal(|journal| { journal.check_code = Some("update.bootstrap_required".into()); Ok(()) })?;
                if super::unix_clearance::ready_with(true, Some(&process))? {
                    let digest = bundle.install_factory()?;
                    super::unix_legacy::retire_cleared(&digest)?;
                    macos_bundle::select(&digest)?;
                    true
                } else { false }
            };
            if ready { break; }
            std::thread::sleep(Duration::from_secs(3));
        }
        unix_runtime::initialize_selected()?
    };
    super::macos_cli::install()?;
    let _pin = unix_runtime::pin_worker(&image)?;
    let error = Command::new(image).arg("update-service").env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin").current_dir("/")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).exec();
    let _ = error;
    Err("update.service_unavailable")
}
