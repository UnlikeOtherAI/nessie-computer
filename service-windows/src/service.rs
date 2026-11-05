//! The Windows service itself: `NessieExecutor`, displayed as "Nessie Executor".
//!
//! It runs as the virtual account `NT SERVICE\NessieExecutor` — no password, no
//! interactive logon, its own SID — and starts automatically at boot, which is
//! the whole point of the standalone package: the executor is online before
//! anybody logs in.
//!
//! Start does three things before it supervises anything, and refuses loudly if
//! any of them fails, because an executor that runs an unverified runtime is
//! worse than one that does not run: it checks its own Authenticode provenance,
//! verifies the packaged runtime against its manifest, and establishes the
//! owner-only DACL on its state root through the packaged native helper.
//!
//! Stop closes each daemon's parent-liveness pipe and then reports
//! `STOP_PENDING` with an advancing checkpoint every second for as long as a
//! daemon is still tearing its guests down. Nothing here ever calls
//! `TerminateProcess`.

/// What Services and the tray show. Nothing in the running service reads it —
/// the installer's authoring carries the same string — and the test below is
/// what keeps the two spellings from drifting apart.
#[cfg(test)]
pub const SERVICE_DISPLAY_NAME: &str = "Nessie Executor";

/// How long the service will keep reporting `STOP_PENDING` for a daemon that
/// has not finished tearing down. Reached only if a daemon is wedged; the
/// service still never kills it, it stops reporting and lets the SCM decide.
#[cfg(windows)]
const STOP_REPORT_LIMIT: std::time::Duration = std::time::Duration::from_secs(600);

#[cfg(windows)]
mod imp {
    use std::{
        ffi::OsString,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::{Duration, Instant},
    };

    use windows_service::{
        define_windows_service,
        service::{
            ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
            ServiceType,
        },
        service_control_handler::{self, ServiceControlHandlerResult, ServiceStatusHandle},
        service_dispatcher,
    };

    use super::STOP_REPORT_LIMIT;
    use nessie_windows_common::SERVICE_NAME;
    use crate::{
        control::Control,
        helper::secure_directory,
        log::log_line,
        manifest::verify_packaged_runtime,
        paths::{executors_root, paired_executors, pending_root, service_root},
        pipe,
        provenance::require_release_signature,
        supervisor::Supervisor,
    };

    define_windows_service!(ffi_service_main, service_main);

    /// Hands this process to the SCM. It returns only when the service stops.
    pub fn run() -> Result<(), String> {
        service_dispatcher::start(SERVICE_NAME, ffi_service_main)
            .map_err(|_| "This program runs as the Nessie Executor Windows service.".to_owned())
    }

    fn service_main(_arguments: Vec<OsString>) {
        // Nothing above this has a console to report to, so a refusal reaches a
        // person through the log folder the tray opens.
        if let Err(reason) = run_service() {
            if let Ok(root) = service_root() {
                log_line(&root, &reason);
            }
        }
    }

    fn status(
        current_state: ServiceState,
        controls_accepted: ServiceControlAccept,
        checkpoint: u32,
        wait_hint: Duration,
    ) -> ServiceStatus {
        ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state,
            controls_accepted,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint,
            wait_hint,
            process_id: None,
        }
    }

    fn report(
        handle: &ServiceStatusHandle,
        state: ServiceState,
        controls: ServiceControlAccept,
        checkpoint: u32,
        wait_hint: Duration,
    ) {
        let _ = handle.set_service_status(status(state, controls, checkpoint, wait_hint));
    }

    fn run_service() -> Result<(), String> {
        let root = service_root()?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let requested = Arc::clone(&shutdown);
        let handle = service_control_handler::register(SERVICE_NAME, move |control| match control {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                requested.store(true, Ordering::SeqCst);
                // The accept loop is blocked in `ConnectNamedPipe`; connecting
                // to the pipe is how it is woken without cancelling I/O.
                pipe::poke();
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        })
        .map_err(|_| "The Nessie Executor service could not register its control handler.".to_owned())?;
        report(
            &handle,
            ServiceState::StartPending,
            ServiceControlAccept::empty(),
            1,
            Duration::from_secs(30),
        );

        // A service that cannot verify itself keeps running and refuses in
        // words. Stopping would leave the tray reporting "the service is not
        // running" — the wrong diagnosis for a tampered runtime, naming the
        // wrong remedy — and would leave nothing at all to ask why.
        let control = Arc::new(match start_supervising(&root) {
            Ok(control) => control,
            Err(reason) => {
                log_line(&root, &reason);
                Control::Refused(reason)
            }
        });

        report(
            &handle,
            ServiceState::Running,
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
            0,
            Duration::default(),
        );
        let recovery_shutdown = Arc::clone(&shutdown);
        let recovery_control = Arc::clone(&control);
        let recovery_root = root.clone();
        let recovery = std::thread::spawn(move || {
            while !recovery_shutdown.load(Ordering::SeqCst) {
                if let Some(Ok(mut supervisor)) = recovery_control.supervisor().map(std::sync::Mutex::lock) {
                    for (executor_id, outcome) in supervisor.recover_due() {
                        log_line(&recovery_root, &format!("executor {executor_id} recovery: {outcome}"));
                    }
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        });
        pipe::serve(root.clone(), Arc::clone(&control), Arc::clone(&shutdown));
        shutdown.store(true, Ordering::SeqCst);
        let _ = recovery.join();
        stop_supervising(&root, &handle, &control);
        report(&handle, ServiceState::Stopped, ServiceControlAccept::empty(), 0, Duration::default());
        Ok(())
    }

    /// Provenance, then the packaged runtime, then the state root — in that
    /// order, because each later check would otherwise be run by, or against,
    /// something not yet known to be ours.
    fn start_supervising(root: &std::path::Path) -> Result<Control, String> {
        require_release_signature()?;
        let runtime_root = std::env::current_exe()
            .ok()
            .and_then(|executable| executable.parent().map(std::path::Path::to_path_buf))
            .ok_or_else(|| "Nessie Executor could not locate its packaged runtime.".to_owned())?;
        let runtime = verify_packaged_runtime(&runtime_root)?;
        for directory in [root.to_path_buf(), executors_root(root), pending_root(root)] {
            secure_directory(&runtime.native_helper, &directory)?;
        }
        let control = Control::new(Supervisor::new(root.to_path_buf(), runtime));
        // Every paired executor comes back at boot, but enrolling with Nessie
        // happens in the recovery thread after SCM and the control pipe are
        // running. A temporary outage must not make the service unavailable.
        if let Some(Ok(mut supervisor)) = control.supervisor().map(std::sync::Mutex::lock) {
            for executor_id in paired_executors(root) {
                if let Err(reason) = supervisor.start(&executor_id) {
                    log_line(root, &format!("executor {executor_id} was not queued for recovery: {reason}"));
                }
            }
        }
        Ok(control)
    }

    /// Asks every daemon to stop and keeps the SCM informed while they do. The
    /// checkpoint has to advance or Windows treats the service as hung.
    fn stop_supervising(
        root: &std::path::Path,
        handle: &ServiceStatusHandle,
        control: &Control,
    ) {
        // A refusing service supervises nothing, so there is nothing to wait for.
        let Some(Ok(mut supervisor)) = control.supervisor().map(std::sync::Mutex::lock) else {
            return;
        };
        supervisor.request_shutdown();
        let deadline = Instant::now() + STOP_REPORT_LIMIT;
        let mut checkpoint = 1;
        while supervisor.still_running() > 0 {
            if Instant::now() >= deadline {
                log_line(root, "a daemon is still tearing down; it was never force-killed");
                return;
            }
            report(
                handle,
                ServiceState::StopPending,
                ServiceControlAccept::empty(),
                checkpoint,
                Duration::from_secs(2),
            );
            checkpoint += 1;
            std::thread::sleep(Duration::from_secs(1));
        }
    }
}

#[cfg(windows)]
pub use imp::run;

#[cfg(not(windows))]
pub fn run() -> Result<(), String> {
    Err("The Nessie Executor service runs on Windows.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::SERVICE_DISPLAY_NAME;
    use nessie_windows_common::SERVICE_NAME;

    /// The installer registers the service under these two names and the tray
    /// looks for them; a rename in one place only would leave a service nobody
    /// controls. The shared name's own relationship to the virtual account is
    /// pinned in `nessie-windows-common`.
    #[test]
    fn the_service_names_are_the_ones_the_installer_registers() {
        assert_eq!(SERVICE_NAME, "NessieExecutor");
        assert_eq!(SERVICE_DISPLAY_NAME, "Nessie Executor");
    }
}
