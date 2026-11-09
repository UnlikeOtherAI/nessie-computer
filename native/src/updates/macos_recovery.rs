//! A newer sealed app brings its own runtime to an older installed factory.
//!
//! launchd runs this app-bundled code each time it starts the approved helper,
//! before the helper hands over to the installed protected worker. That worker
//! is as old as the installed runtime, so an app update reaches the machine
//! only here. When the installed runtime is older than the app's and no
//! replacement has started, the app's runtime is installed exactly as first
//! setup installs it: from a verified copy of the sealed app, under the machine
//! barrier, after independent clearance. A waiting transaction the new runtime
//! meets is archived and its drain ends, so an older worker still running finds
//! nothing to install and exits by itself.
use super::{
    admission_unix::{self, Maintenance},
    host::Host,
    macos_bundle::{self, Bundle},
    unix_clearance, unix_legacy,
    unix_process::{self, Process},
    unix_runtime::{self, ERROR},
};
use nessie_executor_updater::{
    catalog::UpdateResult,
    coordinator::Coordinator,
    network::Network,
    recovery::{self, ApplicationPlan},
    storage::Store,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// A healthy older factory keeps serving its teams: try for about a minute,
/// then hand over and let the catalogue deliver the update normally.
const BRIEF_ATTEMPTS: u32 = 20;

/// How long one attempt holds the machine barrier, so no native creation
/// starts, while commands already running end. The app asks its runtime
/// something every few seconds; on dictator a single check per attempt met one
/// of those every time and 1.0.22's helper never cleared for the swap.
const SETTLE: Duration = Duration::from_secs(15);

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn plan(coordinator: &Coordinator) -> UpdateResult<ApplicationPlan> {
    let installed = unix_runtime::installed()?;
    let maintenance = admission_unix::read()?;
    let pending = coordinator.accepted_pending()?;
    recovery::application_plan(
        &installed.version,
        env!("NESSIE_EXECUTOR_VERSION"),
        pending.as_ref().map(|(phase, version)| (*phase, version.as_str())),
        maintenance.target.is_some(),
        maintenance.draining,
    )
}

/// `true` once nothing remains to do: installed, or no longer needed.
fn attempt(coordinator: &Coordinator, bundle: &Bundle, process: &Process) -> UpdateResult<bool> {
    let _barrier = match crate::managed_machine_barrier::MachineBarrier::acquire() {
        Ok(barrier) => barrier,
        // A worker or native creation holds it briefly; try again shortly.
        Err(_) => return Ok(false),
    };
    // The worker may have finished, or started, a replacement meanwhile.
    if plan(coordinator)? == ApplicationPlan::Keep {
        return Ok(true);
    }
    // The menu app stays: only the factory changes, never the app bundle.
    let settled = Instant::now() + SETTLE;
    while !unix_clearance::ready_with(true, Some(process))? {
        if Instant::now() >= settled { return Ok(false); }
        std::thread::sleep(Duration::from_millis(250));
    }
    let digest = bundle.install_factory()?;
    unix_legacy::retire_cleared(&digest)?;
    macos_bundle::select(&digest)?;
    coordinator.retire_obsolete(now())?;
    if coordinator.store.journal()?.pending.is_none() {
        admission_unix::write(&Maintenance { format: 1, draining: false, restart_ready: false, target: None })?;
    }
    Ok(true)
}

pub(super) fn application_runtime(store: &Store) -> UpdateResult<()> {
    let network = Network::default();
    let coordinator = Coordinator { store, network: &network, installer: &Host };
    let ApplicationPlan::Install { persistent } = plan(&coordinator)? else {
        return Ok(());
    };
    // Verifies the copied seal and that its runtime is this compiled version.
    let bundle = Bundle::registered()?;
    let process = unix_process::information(std::process::id() as i32)?.ok_or(ERROR)?;
    let mut attempts = 0;
    while !attempt(&coordinator, &bundle, &process)? {
        attempts += 1;
        // Admissions held for nothing newer than this app: no team can start
        // anyway, so keep trying instead of returning to the stuck worker.
        if !persistent && attempts >= BRIEF_ATTEMPTS {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(3));
    }
    Ok(())
}
