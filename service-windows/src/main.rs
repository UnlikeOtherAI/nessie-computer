//! `nessie-executor-service.exe` — the standalone package's daemon host.
//!
//! Started by the Service Control Manager with no arguments, it becomes the
//! `NessieExecutor` service. The installer uses fixed setup modes:
//! `--join-hyperv-administrators` puts the virtual service
//! account into the Hyper-V Administrators alias, as a deferred custom action
//! after the service is created. Both modes and nothing else — a control surface
//! belongs on the pipe, where the DACL decides who reaches it. The state and
//! updater setup modes establish their separate service-owned and SYSTEM roots.
//!
//! Everything except the Win32 modules also compiles and runs its tests on a
//! non-Windows host, deliberately: the protocol's validation, the manifest
//! rules, the lease decision and the argument builders are where the behaviour
//! lives, and a check that only ever runs on the release machine is a check
//! nobody runs. On such a host the service entry points are stubs, so almost
//! every item is unreachable — hence the one allow below, which is scoped to
//! that build alone and never applies to the shipped binary.
// A service has no console, and the installer runs this binary as a deferred
// custom action to join the Hyper-V alias; a console subsystem made that flash
// a window mid-install. The SCM entry point and the installer mode are the only
// two ways in, and neither has a console to write to.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
#![cfg_attr(not(windows), allow(dead_code))]

mod control;
mod inference_connections;
mod helper;
mod hyperv;
use nessie_windows_common::lease;
mod log;
use nessie_windows_common::runtime as manifest;
#[cfg(windows)]
mod custody;
mod custody_store;
mod paths;
#[cfg(windows)]
mod pipe;
mod protocol;
mod provenance;
#[cfg(windows)]
mod security;
mod service;
mod service_chatgpt;
mod supervisor;
mod supervisor_commands;
mod supervisor_pairing;
mod supervisor_public_json;

const USAGE: &str = "nessie-executor-service runs as the Nessie Executor Windows service. \
                     Its other modes are --secure-state-root, --secure-updater-root, --disable-updater-for-removal and --join-hyperv-administrators, \
                     which the installer uses while registering the service.";

#[derive(Debug, PartialEq, Eq)]
enum Mode {
    JoinHypervAdministrators,
    RunService,
    SecureStateRoot,
    SecureUpdaterRoot,
    DisableUpdaterForRemoval,
}

fn parse_mode(arguments: &[String]) -> Result<Mode, String> {
    match arguments {
        [] => Ok(Mode::RunService),
        [only] if only == "--join-hyperv-administrators" => Ok(Mode::JoinHypervAdministrators),
        [only] if only == "--secure-state-root" => Ok(Mode::SecureStateRoot),
        [only] if only == "--secure-updater-root" => Ok(Mode::SecureUpdaterRoot),
        [only] if only == "--disable-updater-for-removal" => Ok(Mode::DisableUpdaterForRemoval),
        _ => Err(USAGE.to_owned()),
    }
}

/// Establishes the three state directories the service account owns, before the
/// service ever runs.
///
/// The installer used to call the packaged helper directly, once per directory.
/// The helper is a console program, so each call flashed a black window — three
/// of them across one install, which is not what an installer may look like.
/// Doing it here costs nothing: this binary has no console of its own, and it
/// runs the helper with its output piped, so no window is ever created. The
/// helper stays a console tool a person can still run by hand and read.
///
/// The paths are derived here rather than taken from the command line, for the
/// same reason the service derives them: a state root named by a caller is a
/// state root an installer transform could move somewhere nobody audited.
#[cfg(windows)]
fn secure_state_root() -> Result<(), String> {
    let root = paths::service_root()?;
    let runtime_root = std::env::current_exe()
        .ok()
        .and_then(|executable| executable.parent().map(std::path::Path::to_path_buf))
        .ok_or_else(|| "Nessie Executor could not locate its packaged runtime.".to_owned())?;
    let helper = manifest::verify_packaged_runtime(&runtime_root)?.native_helper;
    for directory in [
        root.clone(),
        paths::executors_root(&root),
        paths::pending_root(&root),
    ] {
        helper::secure_service_directory(&helper, &directory)?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn secure_state_root() -> Result<(), String> {
    Err("Nessie Executor secures its state root on Windows only.".to_owned())
}

#[cfg(windows)]
fn configure_updater(operation: &str) -> Result<(), String> {
    use std::{os::windows::process::CommandExt, process::{Command, Stdio}};
    let directory = std::env::current_exe().map_err(|_| "Updater setup could not locate its runtime.")?
        .parent().ok_or("Updater setup could not locate its runtime.")?.to_path_buf();
    let helper = manifest::verify_packaged_runtime(&directory)?.native_helper;
    let result = Command::new(helper).arg(operation).stdin(Stdio::null())
        .stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(0x0800_0000).status()
        .map_err(|_| "Updater setup could not start its native helper.")?;
    if !result.success() { return Err("Updater setup could not verify its protected state.".into()); }
    Ok(())
}
#[cfg(not(windows))]
fn configure_updater(_operation: &str) -> Result<(), String> { Err("Updater setup requires Windows.".into()) }

fn main() {
    let dsn = std::env::var("NESSIE_COMPUTER_SENTRY_DSN").ok()
        .or_else(|| option_env!("NESSIE_COMPUTER_SENTRY_DSN").map(str::to_owned))
        .filter(|dsn| !dsn.is_empty());
    let _sentry = dsn.map(|dsn| sentry::init(
        sentry::ClientOptions::new().dsn(&dsn).maybe_release(option_env!("GITHUB_SHA")),
    ));
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let outcome = match parse_mode(&arguments) {
        Ok(Mode::RunService) => service::run(),
        Ok(Mode::JoinHypervAdministrators) => hyperv::join_hyperv_administrators(),
        Ok(Mode::SecureStateRoot) => secure_state_root(),
        Ok(Mode::SecureUpdaterRoot) => configure_updater("update-install"),
        Ok(Mode::DisableUpdaterForRemoval) => configure_updater("update-uninstall"),
        Err(usage) => Err(usage),
    };
    if let Err(reason) = outcome {
        // A custom action reads the exit code; the SCM reads the service status.
        // Either way the reason belongs on stderr rather than in a dialog no
        // unattended install would ever show.
        sentry::capture_message(&reason, sentry::Level::Error);
        drop(_sentry);
        eprintln!("{reason}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_mode, Mode, USAGE};

    #[test]
    fn no_arguments_means_the_service_control_manager_started_it() {
        assert_eq!(parse_mode(&[]), Ok(Mode::RunService));
    }

    #[test]
    fn the_installers_two_extra_modes_are_the_only_extra_modes() {
        assert_eq!(
            parse_mode(&["--join-hyperv-administrators".to_owned()]),
            Ok(Mode::JoinHypervAdministrators),
        );
        assert_eq!(
            parse_mode(&["--secure-state-root".to_owned()]),
            Ok(Mode::SecureStateRoot)
        );
        for arguments in [
            vec!["--pair".to_owned()],
            vec!["status".to_owned()],
            vec![
                "--join-hyperv-administrators".to_owned(),
                "extra".to_owned(),
            ],
            vec!["--join-hyperv-administrators=1".to_owned()],
            vec!["--secure-state-root".to_owned(), "extra".to_owned()],
            vec!["--secure-state-root=1".to_owned()],
            vec!["--secure-state-roots".to_owned()],
        ] {
            assert_eq!(
                parse_mode(&arguments),
                Err(USAGE.to_owned()),
                "arguments {arguments:?} must be refused",
            );
        }
    }
}
