mod command;
mod t3_source;
mod updates;
mod chatgpt_browser;
mod job_run;
mod kernel_context;
#[cfg(target_os = "macos")]
mod macos_provenance;
#[cfg(target_os = "macos")]
mod macos_processes;
#[cfg(target_os = "macos")]
mod managed_macos_installed;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod unix_kernel;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod managed_release;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod managed_runtime_context;
#[cfg(target_os = "linux")]
mod managed_runtime;
#[cfg(target_os = "macos")]
#[path = "managed_macos_runtime.rs"]
mod managed_runtime;
#[cfg(target_os = "linux")]
mod managed_inventory;
#[cfg(target_os = "macos")]
#[path = "managed_macos_inventory.rs"]
mod managed_inventory;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod managed_machine_barrier;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod managed_transition;
#[cfg(target_os = "linux")]
mod managed_installed;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod managed_socket;
#[cfg(windows)]
mod managed_windows;
mod personal_state;
mod personal_state_context;
mod terminal_run;
// The workspace commands act on inherited directory descriptors with `openat`
// and friends, which have no Windows equivalent: the Windows helper exists for
// the state-security commands and `job-run`, and the parser above still knows
// every command so the argument contract is one table on every host.
#[cfg(unix)]
mod preflight;
#[cfg(unix)]
mod promotion;
#[cfg(unix)]
mod promotion_fs;
mod protocol;
mod state_security;

use command::{parse_command, Command};
use protocol::{
    JobRunResponse, JobRunStatus, NativeError, PreflightResponse, PreflightStatus,
    PromotionResponse, PromotionStatus, StateSecurityResponse, StateSecurityStatus,
    JOB_RUN_REFUSED_EXIT_CODE,
};
use std::env;

fn respond(response: &PreflightResponse) {
    let encoded = serde_json::to_string(response).expect("response is serializable");
    println!("{encoded}");
}

fn respond_promotion(response: &PromotionResponse) {
    let encoded = serde_json::to_string(response).expect("response is serializable");
    println!("{encoded}");
}

fn respond_state_security(response: &StateSecurityResponse) {
    let encoded = serde_json::to_string(response).expect("response is serializable");
    println!("{encoded}");
}

#[cfg(unix)]
fn run_preflight() -> Result<(), NativeError> {
    let request = preflight::read_request()?;
    preflight::preflight(3, 4, &request)?;
    respond(&PreflightResponse {
        code: None,
        manifest_digest: request.manifest_digest,
        run_id: request.run_id,
        status: PreflightStatus::Ready,
    });
    Ok(())
}

#[cfg(unix)]
fn run_promotion() -> Result<(), NativeError> {
    let request = promotion::read_promotion_request()?;
    promotion::apply(3, 4, &request)?;
    respond_promotion(&PromotionResponse {
        code: None,
        manifest_digest: request.manifest_digest,
        promotion_id: request.promotion_id,
        run_id: request.run_id,
        status: PromotionStatus::Applied,
    });
    Ok(())
}

#[cfg(not(unix))]
fn run_preflight() -> Result<(), NativeError> {
    Err(NativeError::new("EXECUTOR_NATIVE_UNSUPPORTED_PLATFORM"))
}

#[cfg(not(unix))]
fn run_promotion() -> Result<(), NativeError> {
    Err(NativeError::new("EXECUTOR_NATIVE_UNSUPPORTED_PLATFORM"))
}

fn run_managed(arguments: &[String]) -> Result<i32, NativeError> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        managed_runtime::run(arguments)
    }
    #[cfg(windows)]
    {
        managed_windows::run(arguments)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = arguments;
        Err(NativeError::new("EXECUTOR_NATIVE_UNSUPPORTED_PLATFORM"))
    }
}

fn install_managed_custody() -> Result<(), NativeError> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let _release = managed_release::load()?;
        managed_machine_barrier::install()?;
        updates::install()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        Err(NativeError::new("EXECUTOR_NATIVE_UNSUPPORTED_PLATFORM"))
    }
}

fn managed_barrier(nonce: &str) -> Result<(), NativeError> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        managed_inventory::barrier(nonce)
    }
    #[cfg(windows)]
    {
        managed_windows::inventory(nonce)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = nonce;
        Err(NativeError::new("EXECUTOR_NATIVE_UNSUPPORTED_PLATFORM"))
    }
}

fn run(command: &Command) -> Result<(), NativeError> {
    match command {
        Command::T3SourceRead => t3_source::run(),
        Command::T3RetainedApprove(nonce) => t3_source::approve_retained_import(&nonce),
        Command::T3RetainedVerify => t3_source::verify_retained_import(),
        Command::BuildInfo => {
            println!("{}", serde_json::json!({
                "version": env!("NESSIE_EXECUTOR_VERSION"),
                "sourceCommit": env!("NESSIE_EXECUTOR_SOURCE_COMMIT"),
                "managedLaunchProtocol": 1,
                "personalInferenceGuardVersion": 2,
            }));
            Ok(())
        },
        Command::UpdateControl => updates::control(),
        Command::UpdateService => updates::service(),
        Command::UpdateRegisteredService => updates::registered_service(),
        Command::UpdateInstall => updates::install(),
        Command::UpdateUninstall => updates::uninstall(),
        Command::UpdateWorker => updates::worker(),
        Command::UpdateApplicationReopen => updates::reopen_application(),
        Command::PersonalChatgptBrowser => chatgpt_browser::open(),
        Command::KernelProcessContext(pid) => kernel_context::respond(*pid),
        Command::VerifyServiceContext => {
            state_security::verify_service_context()?;
            respond_state_security(&StateSecurityResponse {
                code: None,
                status: StateSecurityStatus::Verified,
            });
            Ok(())
        }
        // The program owns stdout and the exit code from here on, so the
        // helper says nothing on success and leaves with the program's code.
        Command::ManagedCustodyInstall => install_managed_custody(),
        Command::ManagedRuntime(argv) => std::process::exit(run_managed(argv)?),
        Command::ManagedInventoryBarrier(nonce) => managed_barrier(nonce),
        Command::ManagedHostBarrier(nonce) => {
            #[cfg(windows)]
            {
                managed_windows::host_barrier(nonce)
            }
            #[cfg(not(windows))]
            {
                let _ = nonce;
                Err(NativeError::new("EXECUTOR_NATIVE_UNSUPPORTED_PLATFORM"))
            }
        }
        Command::ManagedHostCheck
        | Command::ManagedProtectionStatus
        | Command::ManagedProtectionCleanup => {
            #[cfg(windows)]
            {
                match command {
                    Command::ManagedHostCheck => managed_windows::host_check(),
                    Command::ManagedProtectionStatus => managed_windows::status(),
                    _ => managed_windows::cleanup(),
                }
            }
            #[cfg(not(windows))]
            {
                Err(NativeError::new("EXECUTOR_NATIVE_UNSUPPORTED_PLATFORM"))
            }
        }
        Command::ManagedProtectionRevoke(epoch) | Command::ManagedProtectionClear(epoch) => {
            #[cfg(windows)]
            {
                managed_windows::protection(
                    epoch,
                    matches!(command, Command::ManagedProtectionClear(_)),
                )
            }
            #[cfg(not(windows))]
            {
                let _ = epoch;
                Err(NativeError::new("EXECUTOR_NATIVE_UNSUPPORTED_PLATFORM"))
            }
        }
        Command::JobRun(argv) => std::process::exit(job_run::run(argv)?),
        Command::TerminalRun(argv) => std::process::exit(terminal_run::run(argv)?),
        Command::PersonalStateContext => {
            personal_state_context::require_release()?;
            let root = personal_state_context::protected_root()?;
            println!(
                "{}",
                serde_json::json!({"status":"verified", "protocolVersion":1,
                "root":root, "durability":"process_crash", "kernelLock":true, "digestCas":true})
            );
            Ok(())
        }
        Command::PersonalStateBarrier(path) => {
            personal_state_context::require_release()?;
            personal_state::read_gate()?;
            personal_state::barrier(path)?;
            respond_state_security(&StateSecurityResponse {
                code: None,
                status: StateSecurityStatus::Verified,
            });
            Ok(())
        }
        Command::PersonalStateDirectory(path) => {
            personal_state_context::require_release()?;
            personal_state::read_gate()?;
            personal_state::ensure_directory(path)?;
            respond_state_security(&StateSecurityResponse {
                code: None,
                status: StateSecurityStatus::Secured,
            });
            Ok(())
        }
        Command::PersonalStateReplace(path, expected) => {
            personal_state_context::require_release()?;
            personal_state::mutate(
                path,
                expected.as_deref(),
                Some(&personal_state::read_bytes()?),
            )?;
            respond_state_security(&StateSecurityResponse {
                code: None,
                status: StateSecurityStatus::Secured,
            });
            Ok(())
        }
        Command::PersonalStateDelete(path, expected) => {
            personal_state_context::require_release()?;
            personal_state::read_gate()?;
            personal_state::mutate(path, Some(expected), None)?;
            respond_state_security(&StateSecurityResponse {
                code: None,
                status: StateSecurityStatus::Secured,
            });
            Ok(())
        }
        Command::WorkspacePreflight => run_preflight(),
        Command::WorkspaceApply => run_promotion(),
        Command::SecureDirectory(path) => {
            state_security::secure_directory(path)?;
            respond_state_security(&StateSecurityResponse {
                code: None,
                status: StateSecurityStatus::Secured,
            });
            Ok(())
        }
        Command::SecureServiceDirectory(path) => {
            state_security::secure_service_directory(path)?;
            respond_state_security(&StateSecurityResponse {
                code: None,
                status: StateSecurityStatus::Secured,
            });
            Ok(())
        }
        Command::VerifyOwnerOnly(path) => {
            state_security::verify_owner_only(path)?;
            respond_state_security(&StateSecurityResponse {
                code: None,
                status: StateSecurityStatus::Verified,
            });
            Ok(())
        }
        Command::VerifyOwnerOnlyFile(path) => {
            state_security::verify_owner_only_file(path)?;
            respond_state_security(&StateSecurityResponse {
                code: None,
                status: StateSecurityStatus::Verified,
            });
            Ok(())
        }
        Command::SecureOwnerOnlyFile(path) => {
            state_security::secure_owner_only_file(path)?;
            respond_state_security(&StateSecurityResponse {
                code: None,
                status: StateSecurityStatus::Secured,
            });
            Ok(())
        }
    }
}

/// A refusal answers in the shape of the command that was asked for, so a
/// caller parses one response type per command and never a foreign one. An
/// unparsable argv keeps answering in the promotion shape, as it always has.
fn reject(command: Option<&Command>, error: &NativeError) {
    match command {
        Some(Command::BuildInfo | Command::UpdateControl | Command::UpdateService
            | Command::UpdateRegisteredService
            | Command::UpdateInstall | Command::UpdateUninstall | Command::UpdateWorker | Command::UpdateApplicationReopen) => {
            println!("{}", serde_json::json!({"error":error.code}));
        }
        Some(Command::KernelProcessContext(_)) => {
            println!(
                "{}",
                serde_json::json!({"version":1,"status":"rejected","code":error.code})
            );
        }
        Some(Command::ManagedRuntime(_))
        | Some(Command::JobRun(_))
        | Some(Command::TerminalRun(_)) => {
            let encoded = serde_json::to_string(&JobRunResponse {
                code: Some(error.code.to_owned()),
                status: JobRunStatus::Rejected,
            })
            .expect("response is serializable");
            eprintln!("{encoded}");
        }
        Some(Command::WorkspacePreflight) => respond(&PreflightResponse {
            code: Some(error.code.to_owned()),
            manifest_digest: String::new(),
            run_id: String::new(),
            status: PreflightStatus::Rejected,
        }),
        Some(Command::T3SourceRead | Command::T3RetainedApprove(_) | Command::T3RetainedVerify)
        | Some(Command::PersonalChatgptBrowser)
        | Some(Command::ManagedCustodyInstall)
        | Some(Command::VerifyServiceContext)
        | Some(Command::ManagedInventoryBarrier(_))
        | Some(Command::ManagedHostBarrier(_))
        | Some(Command::ManagedHostCheck)
        | Some(Command::ManagedProtectionStatus)
        | Some(Command::ManagedProtectionCleanup)
        | Some(Command::ManagedProtectionRevoke(_))
        | Some(Command::ManagedProtectionClear(_))
        | Some(Command::PersonalStateContext)
        | Some(Command::PersonalStateDirectory(_))
        | Some(Command::PersonalStateBarrier(_))
        | Some(Command::PersonalStateReplace(_, _))
        | Some(Command::PersonalStateDelete(_, _))
        | Some(Command::SecureDirectory(_))
        | Some(Command::SecureServiceDirectory(_))
        | Some(Command::VerifyOwnerOnly(_))
        | Some(Command::VerifyOwnerOnlyFile(_))
        | Some(Command::SecureOwnerOnlyFile(_)) => respond_state_security(&StateSecurityResponse {
            code: Some(error.code.to_owned()),
            status: StateSecurityStatus::Rejected,
        }),
        Some(Command::WorkspaceApply) | None => respond_promotion(&PromotionResponse {
            code: Some(error.code.to_owned()),
            manifest_digest: String::new(),
            promotion_id: String::new(),
            run_id: String::new(),
            status: PromotionStatus::Rejected,
        }),
    }
}

fn main() {
    let arguments: Vec<String> = env::args().skip(1).collect();
    let outcome = match parse_command(&arguments) {
        Ok(command) => run(&command).map_err(|error| (Some(command), error)),
        Err(error) => Err((None, error)),
    };
    if let Err((command, error)) = outcome {
        reject(command.as_ref(), &error);
        let refused = matches!(command, Some(Command::JobRun(_)));
        std::process::exit(if refused {
            JOB_RUN_REFUSED_EXIT_CODE
        } else {
            1
        });
    }
}
