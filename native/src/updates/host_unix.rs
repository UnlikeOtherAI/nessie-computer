//! Native Unix installation retains the same custody inode and accepted journal.
use super::super::{admission_unix, unix_health, unix_runtime};
#[cfg(target_os = "linux")]
use super::super::unix_setup;
use nessie_executor_updater::catalog::UpdateResult;
pub(in crate::updates) use super::super::unix_package::{verify_publishers, replace_when_clear};
pub(in crate::updates) use super::super::unix_runtime::installed;
pub(in crate::updates) use super::super::unix_health::confirm_restarted;

pub(in crate::updates) fn installation_status() -> UpdateResult<(nessie_executor_updater::coordinator::Installed, bool)> {
    let release = crate::managed_release::installed().map_err(|_| unix_runtime::ERROR)?;
    let installed = unix_runtime::release_information(&release)?;
    let can_install = super::super::unix_legacy::remaining(&release.digest)
        .and_then(|remaining| if remaining { Err("update.bootstrap_required") }
            else { super::super::unix_package::target() }).is_ok();
    Ok((installed, can_install))
}

pub(in crate::updates) fn target() -> UpdateResult<nessie_executor_updater::protocol::Target> {
    let release = crate::managed_release::installed().map_err(|_| "update.installed_release_unverified")?;
    if super::super::unix_legacy::remaining(&release.digest)? { return Err("update.bootstrap_required"); }
    super::super::unix_package::target()
}

pub(in crate::updates) fn set_draining(draining: bool, restart_ready: bool) -> UpdateResult<()> {
    unix_runtime::privileged()?;
    let _barrier = crate::managed_machine_barrier::MachineBarrier::acquire().map_err(|_| "update.admission_busy")?;
    if draining && !restart_ready { unix_health::capture()?; }
    let mut state = admission_unix::read()?;
    state.draining = draining;
    state.restart_ready = restart_ready;
    admission_unix::write(&state)
}

pub(in crate::updates) fn initialize() -> UpdateResult<()> {
    #[cfg(target_os = "macos")]
    { Err("update.setup_required") }
    #[cfg(target_os = "linux")]
    {
    let worker = unix_runtime::initialize()?;
    nessie_executor_updater::storage::Store::new(super::root()?).set_installation_enabled(true)?;
    unix_setup::configure(&worker)
    }
}

pub(in crate::updates) fn uninstall() -> UpdateResult<()> {
    unix_runtime::privileged()?;
    unix_runtime::directory(&super::root()?)?;
    nessie_executor_updater::storage::Store::new(super::root()?).set_installation_enabled(false)
}
