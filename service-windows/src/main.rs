//! `nessie-executor-service.exe` — the standalone package's daemon host.
//!
//! Started by the Service Control Manager with no arguments, it becomes the
//! `NessieExecutor` service. The installer uses fixed setup modes:
//! `--join-hyperv-administrators` puts the virtual service
//! account into the Hyper-V Administrators alias, as a deferred custom action
//! after the service is created. The state and updater setup modes establish
//! their separate service-owned and SYSTEM roots. `--control` is the command
//! line's client of the control pipe (`client.rs`): it runs as the person who
//! typed the command, so the pipe's DACL still decides who reaches the service.
//! A control surface belongs on the pipe, never on this executable's arguments.
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

mod client;
mod control;
mod inference_connections;
mod helper;
mod hyperv;
mod install_modes;
use nessie_windows_common::lease;
mod log;
use nessie_windows_common::runtime as manifest;
use setup_report::Refusal;
#[cfg(windows)]
mod custody;
#[cfg(windows)]
mod execution;
#[cfg(windows)]
mod execution_admission;
#[cfg(windows)]
mod execution_context;
#[cfg(windows)]
mod execution_key;
#[cfg(windows)]
mod execution_observation;
#[cfg(windows)]
mod execution_preparation;
#[cfg(windows)]
mod execution_launch_homes;
#[cfg(windows)]
mod execution_resource;
#[cfg(windows)]
mod execution_creator;
#[cfg(windows)]
mod execution_process;
#[cfg(windows)]
mod execution_process_io;
#[cfg(windows)]
mod execution_input;
#[cfg(windows)]
mod execution_secret_attempt;
#[cfg(windows)]
mod execution_frames;
#[cfg(windows)]
mod execution_effect;
#[cfg(windows)]
mod execution_session_host;
#[cfg(windows)]
mod execution_creator_owner;
mod custody_store;
mod paths;
#[cfg(windows)]
mod pipe;
mod protocol;
mod protocol_values;
mod provenance;
#[cfg(windows)]
mod security;
mod service;
mod service_chatgpt;
mod setup_report;
mod supervisor;
mod supervisor_commands;
mod supervisor_names;
mod supervisor_pairing;
mod supervisor_owner;
mod supervisor_public_json;
mod supervisor_run;

const USAGE: &str = "nessie-executor-service runs as the Nessie Computer Windows service. \
                     Its other modes are --secure-state-root, --secure-updater-root, --disable-updater-for-removal, \
                     --join-hyperv-administrators, --close-for-install and --reopen-after-install, which the installer uses, \
                     and --control, which nessie-computer uses.";

#[derive(Debug, PartialEq, Eq)]
enum Mode {
    Control,
    JoinHypervAdministrators,
    RunService,
    SecureStateRoot,
    SecureUpdaterRoot,
    DisableUpdaterForRemoval,
    CloseForInstall,
    ReopenAfterInstall,
}

fn parse_mode(arguments: &[String]) -> Result<Mode, String> {
    match arguments {
        [] => Ok(Mode::RunService),
        [only] if only == "--control" => Ok(Mode::Control),
        [only] if only == "--join-hyperv-administrators" => Ok(Mode::JoinHypervAdministrators),
        [only] if only == "--secure-state-root" => Ok(Mode::SecureStateRoot),
        [only] if only == "--secure-updater-root" => Ok(Mode::SecureUpdaterRoot),
        [only] if only == "--disable-updater-for-removal" => Ok(Mode::DisableUpdaterForRemoval),
        [only] if only == "--close-for-install" => Ok(Mode::CloseForInstall),
        [only] if only == "--reopen-after-install" => Ok(Mode::ReopenAfterInstall),
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
        .ok_or_else(|| "Nessie Computer could not locate its packaged runtime.".to_owned())?;
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
    Err("Nessie Computer secures its state root on Windows only.".to_owned())
}

/// Sets up or disables the updater through the packaged native helper. A
/// refusal keeps the helper's own code (`setup_report`), so the installer's
/// rollback can be explained afterwards.
#[cfg(windows)]
fn configure_updater(operation: &str) -> Result<(), Refusal> {
    use std::{os::windows::process::CommandExt, process::{Command, Stdio}};
    let directory = std::env::current_exe().ok()
        .and_then(|executable| executable.parent().map(std::path::Path::to_path_buf))
        .ok_or_else(|| Refusal::new("updater_setup.runtime_unlocated"))?;
    let helper = manifest::verify_packaged_runtime(&directory)
        .map_err(|reason| Refusal::with("updater_setup.runtime_unverified", reason))?.native_helper;
    let output = Command::new(helper).arg(operation).stdin(Stdio::null())
        .stdout(Stdio::piped()).stderr(Stdio::null()).creation_flags(0x0800_0000).output()
        .map_err(|_| Refusal::new("updater_setup.helper_unstartable"))?;
    if !output.status.success() {
        return Err(Refusal::helper("updater_setup.helper_refused", &output.stdout, output.status.code()));
    }
    Ok(())
}
#[cfg(not(windows))]
fn configure_updater(_operation: &str) -> Result<(), Refusal> {
    Err(Refusal::with("updater_setup.unsupported", "Updater setup requires Windows."))
}

/// A setup mode's refusal, reported with its stable code (`setup_report`).
fn setup(mode: &str, outcome: Result<(), Refusal>) -> Result<(), String> {
    outcome.map_err(|refusal| setup_report::report(mode, &refusal))
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let outcome = match parse_mode(&arguments) {
        Ok(Mode::RunService) => service::run(),
        Ok(Mode::Control) => client::run(),
        Ok(Mode::JoinHypervAdministrators) => hyperv::join_hyperv_administrators(),
        Ok(Mode::SecureStateRoot) => setup("--secure-state-root",
            secure_state_root().map_err(|reason| Refusal::with("state_setup.refused", reason))),
        Ok(Mode::SecureUpdaterRoot) => setup("--secure-updater-root", configure_updater("update-install")),
        Ok(Mode::DisableUpdaterForRemoval) => {
            setup("--disable-updater-for-removal", configure_updater("update-uninstall"))
        }
        Ok(Mode::CloseForInstall) => setup("--close-for-install", install_modes::close_for_install()),
        Ok(Mode::ReopenAfterInstall) => setup("--reopen-after-install", install_modes::reopen_after_install()),
        Err(usage) => Err(usage),
    };
    if let Err(reason) = outcome {
        // A custom action reads the exit code; the SCM reads the service status.
        // Either way the reason belongs on stderr rather than in a dialog no
        // unattended install would ever show. Setup modes also wrote it to the
        // Application event log, which outlives the installer's rollback.
        eprintln!("{reason}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_mode, setup, Mode, USAGE};
    use crate::setup_report::Refusal;

    #[test]
    fn a_setup_refusal_is_reported_with_its_code_and_success_is_silent() {
        assert_eq!(setup("--secure-updater-root", Ok(())), Ok(()));
        let reason = setup("--secure-updater-root", Err(Refusal::new("updater_setup.helper_unstartable")))
            .expect_err("a refusal must fail the custom action");
        assert_eq!(reason, "Nessie Computer setup --secure-updater-root refused: updater_setup.helper_unstartable");
    }

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
        assert_eq!(parse_mode(&["--control".to_owned()]), Ok(Mode::Control));
        assert_eq!(parse_mode(&["--secure-updater-root".to_owned()]), Ok(Mode::SecureUpdaterRoot));
        assert_eq!(
            parse_mode(&["--disable-updater-for-removal".to_owned()]),
            Ok(Mode::DisableUpdaterForRemoval),
        );
        assert_eq!(parse_mode(&["--close-for-install".to_owned()]), Ok(Mode::CloseForInstall));
        assert_eq!(parse_mode(&["--reopen-after-install".to_owned()]), Ok(Mode::ReopenAfterInstall));
        for arguments in [
            vec!["--control".to_owned(), "status".to_owned()],
            vec!["--control=status".to_owned()],
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
            // The install folder is derived, never named by the installer.
            vec!["--close-for-install".to_owned(), r"C:\Elsewhere".to_owned()],
        ] {
            assert_eq!(
                parse_mode(&arguments),
                Err(USAGE.to_owned()),
                "arguments {arguments:?} must be refused",
            );
        }
    }
}
