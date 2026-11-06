use crate::protocol::{NativeError, MAX_PATH_LENGTH};

/// The most arguments `job-run` passes on, and the longest one. Windows caps a
/// whole command line at 32 767 UTF-16 units, so neither limit is reachable by
/// a command that could start; they only keep a malformed argv from being
/// copied around before `CreateProcessW` refuses it.
pub const MAX_JOB_ARGUMENTS: usize = 256;
pub const MAX_JOB_ARGUMENT_LENGTH: usize = 32_767;

/// Every command the helper answers. Parsing is deliberately host-agnostic so
/// the whole table is exercised on any build machine: only the *bodies* behind
/// `secure-directory`, `verify-owner-only` and `job-run` are Windows-only, and
/// only the bodies behind the workspace commands are POSIX-only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    BuildInfo,
    UpdateControl,
    UpdateService,
    UpdateInstall,
    UpdateWorker,
    PersonalChatgptBrowser,
    /// Run one program â€” a coding agent â€” inside a Job Object that kills the
    /// whole tree when the helper exits, passing stdio through and exiting
    /// with the program's own code. The argv after `--` is the program and its
    /// arguments, exactly as given.
    JobRun(Vec<String>),
    ManagedRuntime(Vec<String>),
    ManagedCustodyInstall,
    ManagedInventoryBarrier(String),
    ManagedHostBarrier(String),
    ManagedHostCheck,
    ManagedProtectionStatus,
    ManagedProtectionCleanup,
    ManagedProtectionRevoke(String),
    ManagedProtectionClear(String),
    TerminalRun(Vec<String>),
    /// Create the executor's private state directory if absent and give it an
    /// owner-only, non-inherited DACL.
    SecureDirectory(String),
    /// Establish the standalone service root before the service starts. Its
    /// owner is the virtual service account, not Windows Installer's SYSTEM.
    SecureServiceDirectory(String),
    /// Prove that a directory's owner and DACL still admit nobody else.
    VerifyOwnerOnly(String),
    /// Prove an individual private file has not overridden its directory DACL.
    VerifyOwnerOnlyFile(String),
    /// Preserve a private file's DACL and make its owner the current account.
    SecureOwnerOnlyFile(String),
    PersonalStateContext,
    VerifyServiceContext,
    KernelProcessContext(i32),
    PersonalStateDirectory(String),
    PersonalStateBarrier(String),
    PersonalStateReplace(String, Option<String>),
    PersonalStateDelete(String, String),
    WorkspaceApply,
    WorkspacePreflight,
}

/// Absolute on either host shape, decided without asking this host: a Windows
/// path must verify as absolute when the parser's tests run on Linux, and a
/// POSIX path likewise on a Windows build machine.
fn is_absolute_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.first() == Some(&b'/') {
        return true;
    }
    if value.starts_with(r"\\") {
        return true;
    }
    matches!(bytes, [drive, b':', separator, ..]
        if drive.is_ascii_alphabetic() && (*separator == b'\\' || *separator == b'/'))
}

/// The state directory is named on argv because the helper has to be able to
/// *create* it â€” there is no descriptor to inherit for a path that does not
/// exist yet. It is the supervisor's own state root, never a workspace path and
/// never a secret, and the response echoes nothing back.
fn state_path(value: &str) -> Result<String, NativeError> {
    if value.is_empty() || value.len() > MAX_PATH_LENGTH || value.contains('\0') {
        return Err(NativeError::new("EXECUTOR_NATIVE_USAGE"));
    }
    if !is_absolute_path(value) {
        return Err(NativeError::new("EXECUTOR_NATIVE_USAGE"));
    }
    Ok(value.to_owned())
}

/// The program and its arguments, after the `--` that ends the helper's own
/// argv. Nothing here is interpreted: the executor already chose the program
/// from its owner's reviewed configuration.
fn job_argv(values: &[String]) -> Result<Vec<String>, NativeError> {
    let usable = |value: &String| !value.contains('\0') && value.len() <= MAX_JOB_ARGUMENT_LENGTH;
    match values.first() {
        Some(program)
            if !program.is_empty()
                && values.len() <= MAX_JOB_ARGUMENTS
                && values.iter().all(usable) =>
        {
            Ok(values.to_vec())
        }
        _ => Err(NativeError::new("EXECUTOR_NATIVE_USAGE")),
    }
}

pub fn parse_command(arguments: &[String]) -> Result<Command, NativeError> {
    match arguments {
        [command] if command == "build-info" => Ok(Command::BuildInfo),
        [command] if command == "update-control" => Ok(Command::UpdateControl),
        [command] if command == "update-service" => Ok(Command::UpdateService),
        [command] if command == "update-install" => Ok(Command::UpdateInstall),
        [command] if command == "update-worker" => Ok(Command::UpdateWorker),
        [command] if command == "personal-chatgpt-browser" => Ok(Command::PersonalChatgptBrowser),
        [command] if command == "managed-host-check" => Ok(Command::ManagedHostCheck),
        [command] if command == "managed-protection-status" => Ok(Command::ManagedProtectionStatus),
        [command] if command == "managed-protection-cleanup" => {
            Ok(Command::ManagedProtectionCleanup)
        }
        [command] if command == "managed-custody-install" => Ok(Command::ManagedCustodyInstall),
        [command, separator, rest @ ..] if command == "managed-runtime" && separator == "--" => {
            Ok(Command::ManagedRuntime(if rest.is_empty() {
                Vec::new()
            } else {
                job_argv(rest)?
            }))
        }
        [command, nonce]
            if command == "managed-inventory-barrier"
                && nonce.len() == 64
                && nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) =>
        {
            Ok(Command::ManagedInventoryBarrier(nonce.clone()))
        }
        [command, nonce]
            if command == "managed-host-barrier"
                && nonce.len() == 64
                && nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) =>
        {
            Ok(Command::ManagedHostBarrier(nonce.clone()))
        }
        [command, epoch]
            if (command == "managed-protection-revoke"
                || command == "managed-protection-clear")
                && epoch.len() == 64
                && epoch.bytes().all(|byte| byte.is_ascii_hexdigit()) =>
        {
            Ok(if command == "managed-protection-revoke" {
                Command::ManagedProtectionRevoke(epoch.clone())
            } else {
                Command::ManagedProtectionClear(epoch.clone())
            })
        }
        [command, separator, rest @ ..] if command == "job-run" && separator == "--" => {
            Ok(Command::JobRun(job_argv(rest)?))
        }
        [command, separator, rest @ ..] if command == "terminal-run" && separator == "--" => {
            Ok(Command::TerminalRun(job_argv(rest)?))
        }
        [command] if command == "personal-state-context" => Ok(Command::PersonalStateContext),
        [command] if command == "verify-service-context" => Ok(Command::VerifyServiceContext),
        [command, pid] if command == "kernel-process-context" => {
            let pid = pid
                .parse::<i32>()
                .map_err(|_| NativeError::new("EXECUTOR_NATIVE_USAGE"))?;
            if pid <= 0 {
                return Err(NativeError::new("EXECUTOR_NATIVE_USAGE"));
            }
            Ok(Command::KernelProcessContext(pid))
        }
        [command, path] if command == "personal-state-barrier" => {
            Ok(Command::PersonalStateBarrier(state_path(path)?))
        }
        [command, path] if command == "personal-state-directory" => {
            Ok(Command::PersonalStateDirectory(state_path(path)?))
        }
        [command, path, digest] if command == "personal-state-replace" => {
            Ok(Command::PersonalStateReplace(
                state_path(path)?,
                crate::personal_state::expected(digest)?,
            ))
        }
        [command, path, digest] if command == "personal-state-delete" => {
            let expected = crate::personal_state::expected(digest)?
                .ok_or_else(|| NativeError::new("EXECUTOR_NATIVE_USAGE"))?;
            Ok(Command::PersonalStateDelete(state_path(path)?, expected))
        }
        [command] if command == "workspace-preflight" => Ok(Command::WorkspacePreflight),
        [command] if command == "workspace-apply" => Ok(Command::WorkspaceApply),
        [command, path] if command == "secure-directory" => {
            Ok(Command::SecureDirectory(state_path(path)?))
        }
        [command, path] if command == "secure-service-directory" => {
            Ok(Command::SecureServiceDirectory(state_path(path)?))
        }
        [command, path] if command == "verify-owner-only" => {
            Ok(Command::VerifyOwnerOnly(state_path(path)?))
        }
        [command, path] if command == "verify-owner-only-file" => {
            Ok(Command::VerifyOwnerOnlyFile(state_path(path)?))
        }
        [command, path] if command == "secure-owner-only-file" => {
            Ok(Command::SecureOwnerOnlyFile(state_path(path)?))
        }
        _ => Err(NativeError::new("EXECUTOR_NATIVE_USAGE")),
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_command, Command};
    use crate::protocol::MAX_PATH_LENGTH;

    fn arguments(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn parse(values: &[&str]) -> Result<Command, &'static str> {
        parse_command(&arguments(values)).map_err(|error| error.code)
    }

    #[test]
    fn managed_launch_has_no_caller_selected_node_or_bundle() {
        assert_eq!(
            parse(&["managed-runtime", "--"]),
            Ok(Command::ManagedRuntime(Vec::new()))
        );
        assert_eq!(
            parse(&["managed-runtime", "--", "serve", "--state-dir", "/state"]),
            Ok(Command::ManagedRuntime(arguments(&[
                "serve",
                "--state-dir",
                "/state"
            ])))
        );
        assert!(parse(&["managed-runtime", "/node", "/bundle"]).is_err());
        assert!(parse(&["managed-inventory-barrier", "stale"]).is_err());
    }

    #[test]
    fn personal_state_commands_keep_bytes_off_argv_and_require_exact_cas() {
        assert_eq!(
            parse(&["verify-service-context"]),
            Ok(Command::VerifyServiceContext)
        );
        assert!(parse(&["verify-service-context", "SYSTEM"]).is_err());
        assert_eq!(
            parse(&["kernel-process-context", "42"]),
            Ok(Command::KernelProcessContext(42))
        );
        for pid in ["0", "-1", "2147483648", "not-a-pid"] {
            assert!(parse(&["kernel-process-context", pid]).is_err());
        }
        assert_eq!(
            parse(&["personal-state-context"]),
            Ok(Command::PersonalStateContext)
        );
        assert_eq!(
            parse(&["personal-state-replace", "/state/profile.json", "absent"]),
            Ok(Command::PersonalStateReplace(
                "/state/profile.json".to_owned(),
                None
            ))
        );
        assert!(parse(&[
            "personal-state-replace",
            "/state/profile.json",
            "absent",
            "secret"
        ])
        .is_err());
        assert!(parse(&["personal-state-delete", "/state/profile.json", "absent"]).is_err());
        assert!(parse(&["personal-state-delete", "/state/profile.json", "bad-digest"]).is_err());
    }

    #[test]
    fn the_workspace_commands_keep_taking_no_arguments() {
        assert_eq!(
            parse(&["workspace-preflight"]),
            Ok(Command::WorkspacePreflight)
        );
        assert_eq!(parse(&["workspace-apply"]), Ok(Command::WorkspaceApply));
        assert_eq!(
            parse(&["workspace-apply", "/state"]),
            Err("EXECUTOR_NATIVE_USAGE")
        );
        assert_eq!(parse(&[]), Err("EXECUTOR_NATIVE_USAGE"));
        assert_eq!(parse(&["workspace"]), Err("EXECUTOR_NATIVE_USAGE"));
    }

    #[test]
    fn the_state_commands_take_one_absolute_path_in_either_host_shape() {
        assert_eq!(
            parse(&[
                "secure-directory",
                r"C:\Users\person\AppData\Local\Nessie\executors\one"
            ]),
            Ok(Command::SecureDirectory(
                r"C:\Users\person\AppData\Local\Nessie\executors\one".to_owned(),
            )),
        );
        assert_eq!(
            parse(&[
                "verify-owner-only",
                "/home/person/.local/state/nessie-executor/one"
            ]),
            Ok(Command::VerifyOwnerOnly(
                "/home/person/.local/state/nessie-executor/one".to_owned(),
            )),
        );
        assert_eq!(
            parse(&[
                "verify-owner-only-file",
                r"C:\Users\person\AppData\Local\Nessie\executors\one\state.json"
            ]),
            Ok(Command::VerifyOwnerOnlyFile(
                r"C:\Users\person\AppData\Local\Nessie\executors\one\state.json".to_owned(),
            )),
        );
        assert_eq!(
            parse(&["secure-directory", r"\\?\C:\Nessie\executors\one"]),
            Ok(Command::SecureDirectory(
                r"\\?\C:\Nessie\executors\one".to_owned()
            )),
        );
        assert_eq!(
            parse(&["secure-owner-only-file", "/home/person/private.json"]),
            Ok(Command::SecureOwnerOnlyFile(
                "/home/person/private.json".to_owned()
            )),
        );
        assert_eq!(
            parse(&["secure-directory", "C:/Nessie/executors/one"]).is_ok(),
            true
        );
        assert_eq!(
            parse(&[
                "secure-service-directory",
                r"C:\ProgramData\Nessie Executor"
            ]),
            Ok(Command::SecureServiceDirectory(
                r"C:\ProgramData\Nessie Executor".to_owned()
            )),
        );
    }

    #[test]
    fn a_relative_empty_or_oversized_path_is_a_usage_error() {
        assert_eq!(parse(&["secure-directory"]), Err("EXECUTOR_NATIVE_USAGE"));
        assert_eq!(
            parse(&["secure-directory", ""]),
            Err("EXECUTOR_NATIVE_USAGE")
        );
        assert_eq!(
            parse(&["secure-directory", "executors/one"]),
            Err("EXECUTOR_NATIVE_USAGE")
        );
        assert_eq!(
            parse(&["secure-owner-only-file", "private.json"]),
            Err("EXECUTOR_NATIVE_USAGE")
        );
        assert_eq!(
            parse(&["verify-owner-only", r"..\executors"]),
            Err("EXECUTOR_NATIVE_USAGE")
        );
        assert_eq!(
            parse(&["secure-directory", "C:"]),
            Err("EXECUTOR_NATIVE_USAGE")
        );
        assert_eq!(
            parse(&["secure-directory", "/state\0/one"]),
            Err("EXECUTOR_NATIVE_USAGE")
        );
        let oversized = format!("/{}", "a".repeat(MAX_PATH_LENGTH));
        assert_eq!(
            parse(&["secure-directory", &oversized]),
            Err("EXECUTOR_NATIVE_USAGE")
        );
    }

    #[test]
    fn a_state_command_never_accepts_a_second_path() {
        assert_eq!(
            parse(&["secure-directory", "/one", "/two"]),
            Err("EXECUTOR_NATIVE_USAGE")
        );
    }

    #[test]
    fn job_run_passes_everything_after_the_separator_through_verbatim() {
        assert_eq!(
            parse(&[
                "job-run",
                "--",
                r"C:\Tools\claude.exe",
                "-p",
                "--verbose",
                "--",
                "a b"
            ]),
            Ok(Command::JobRun(vec![
                r"C:\Tools\claude.exe".to_owned(),
                "-p".to_owned(),
                "--verbose".to_owned(),
                "--".to_owned(),
                "a b".to_owned(),
            ])),
        );
        assert_eq!(
            parse(&["job-run", "--", "node"]),
            Ok(Command::JobRun(vec!["node".to_owned()]))
        );
    }

    #[test]
    fn job_run_refuses_a_missing_separator_program_or_malformed_argument() {
        assert_eq!(parse(&["job-run"]), Err("EXECUTOR_NATIVE_USAGE"));
        assert_eq!(parse(&["job-run", "--"]), Err("EXECUTOR_NATIVE_USAGE"));
        assert_eq!(
            parse(&["job-run", "claude.exe"]),
            Err("EXECUTOR_NATIVE_USAGE")
        );
        assert_eq!(parse(&["job-run", "--", ""]), Err("EXECUTOR_NATIVE_USAGE"));
        assert_eq!(
            parse(&["job-run", "--", "claude\0.exe"]),
            Err("EXECUTOR_NATIVE_USAGE")
        );
        let long = "a".repeat(super::MAX_JOB_ARGUMENT_LENGTH + 1);
        assert_eq!(
            parse(&["job-run", "--", "claude.exe", &long]),
            Err("EXECUTOR_NATIVE_USAGE")
        );
        let mut many = vec!["job-run", "--"];
        many.extend(std::iter::repeat("x").take(super::MAX_JOB_ARGUMENTS + 1));
        assert_eq!(parse(&many), Err("EXECUTOR_NATIVE_USAGE"));
    }
}
