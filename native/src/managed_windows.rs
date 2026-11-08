//! Fixed suspended launch, service-published custody, then retained whole-job lifetime.
use crate::{
    job_run::imp::{parent_process, resume, Owned},
    protocol::NativeError,
};
use nessie_windows_common::{
    custody::{Operation, RuntimeKind},
    process::Process,
    service_channel,
};
use std::{
    os::windows::{ffi::OsStrExt, io::AsRawHandle, process::CommandExt},
    process::Command,
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{LocalFree, HANDLE, WAIT_OBJECT_0},
    Security::{
        Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
        Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG},
        SECURITY_ATTRIBUTES,
    },
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
            JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
            TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{WaitForMultipleObjects, CREATE_NO_WINDOW, CREATE_SUSPENDED},
    },
};
const PIN: Option<&str> = option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_EKU");
fn refused() -> NativeError {
    NativeError::new("EXECUTOR_MANAGED_LAUNCH_REJECTED")
}
fn nonce() -> Result<String, NativeError> {
    let mut bytes = [0_u8; 32];
    if unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    } != 0
    {
        return Err(refused());
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn acquire_host() -> Result<String, NativeError> {
    crate::personal_state_context::require_release()?;
    let _release = nessie_windows_common::release::load(PIN).map_err(|_| refused())?;
    let nonce = nonce()?;
    let reply = service_channel::call(
        &Operation::HostAcquire {
            nonce: nonce.clone(),
        },
        PIN,
    )
    .map_err(|_| refused())?;
    if reply["acquired"] != true {
        return Err(refused());
    }
    Ok(nonce)
}
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn release_host(nonce: &str) -> Result<(), NativeError> {
    // Job termination is asynchronous. Retry the service's positive complete
    // job observation; failed or inaccessible clearance leaves the durable lease.
    for _ in 0..100 {
        if service_channel::call(
            &Operation::HostRelease {
                nonce: nonce.into(),
            },
            PIN,
        )
        .is_ok_and(|reply| reply["released"] == true)
        {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Err(refused())
}
fn job(name: &str, owner: &str) -> Result<Owned, NativeError> {
    let service = service_channel::service_account_sid().map_err(|_| refused())?;
    job_with_service(name, owner, &service)
}
fn job_with_service(name: &str, owner: &str, service: &str) -> Result<Owned, NativeError> {
    let acl = format!("D:P(A;;GA;;;{owner})(A;;0x00000004;;;{service})(A;;GA;;;SY)");
    let acl: Vec<u16> = std::ffi::OsStr::new(&acl)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut descriptor = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            acl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(refused());
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let name: Vec<u16> = std::ffi::OsStr::new(name)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let handle = unsafe { CreateJobObjectW(&attributes, name.as_ptr()) };
    let existed = unsafe { windows_sys::Win32::Foundation::GetLastError() }
        == windows_sys::Win32::Foundation::ERROR_ALREADY_EXISTS;
    unsafe { LocalFree(descriptor) };
    if handle.is_null() {
        return Err(refused());
    }
    let job = Owned(handle);
    if existed {
        return Err(refused());
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        )
    } == 0
    {
        return Err(refused());
    }
    Ok(job)
}
fn active(job: HANDLE) -> Result<u32, NativeError> {
    let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe {
        QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
            std::mem::size_of_val(&info) as u32,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(refused());
    }
    Ok(info.ActiveProcesses)
}
pub fn run(arguments: &[String]) -> Result<i32, NativeError> {
    crate::personal_state_context::require_release()?;
    let release = nessie_windows_common::release::load(PIN).map_err(|_| refused())?;
    let service = service_channel::service_account_sid().map_err(|_| refused())?;
    let own = Process::open(std::process::id()).map_err(|_| refused())?;
    if own.session != 0
        && !own.elevated
        && nessie_windows_common::process::interactive(&own).is_ok()
    {
        controls::cleanup_before_launch();
    }
    let parent = parent_process()?;
    let name = format!("Global\\NessieCustody-{}", nonce()?);
    let job = job(&name, &own.sid)?;
    let mut command = Command::new(&release.runtime.node_executable);
    command
        .arg(release.runtime.bundle())
        .args(arguments)
        .env("NESSIE_EXECUTOR_PACKAGED_CLI", "1")
        .env(
            "NESSIE_EXECUTOR_SUPERVISOR",
            if own.session == 0 {
                "service"
            } else {
                "desktop"
            },
        )
        .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy();
        if name.starts_with("NODE_")
            || name.starts_with("NESSIE_MANAGED_")
            || name.starts_with("NESSIE_EXECUTOR_NATIVE_")
            || name.starts_with("NESSIE_TEST_")
        {
            command.env_remove(key);
        }
    }
    command.env_remove("NESSIE_EXECUTOR_ALLOW_LOCAL_API");
    let mut child = command.spawn().map_err(|_| refused())?;
    let process = child.as_raw_handle() as HANDLE;
    let admitted = (|| {
        nessie_windows_common::peer_inspection::allow_process_for(process, &service)
            .map_err(|_| refused())?;
        if unsafe { AssignProcessToJobObject(job.0, process) } == 0 {
            return Err(refused());
        }
        let response = service_channel::call(
            &Operation::Register {
                child_pid: child.id(),
                job_name: name,
                release_digest: release.digest.clone(),
                kind: match (own.session, arguments.first().map(String::as_str)) {
                    (0, Some("personal-chatgpt-service")) => RuntimeKind::MachineAttestation,
                    (0, Some("serve")) => RuntimeKind::ServiceDaemon,
                    (
                        0,
                        Some(
                            "pair" | "pairing-start" | "pairing-status" | "pairing-confirm"
                            | "pairing-cancel" | "configure" | "connect" | "describe" | "unpair" | "local-inference",
                        ),
                    ) => RuntimeKind::ServiceControl,
                    (_, Some("serve" | "serve-direct-local-inference")) => RuntimeKind::UserDaemon,
                    (_, Some("personal-chatgpt" | "personal-chatgpt-local")) => {
                        RuntimeKind::PublicController
                    }
                    (_, Some("personal-chatgpt-credential")) => RuntimeKind::Credential,
                    _ => RuntimeKind::Guarded,
                },
            },
            PIN,
        )
        .map_err(|_| refused())?;
        if response["registered"] != true || !resume(&child) {
            return Err(refused());
        }
        Ok(())
    })();
    if let Err(error) = admitted {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let handles = [process, parent.0];
    let outcome = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, u32::MAX) };
    let code = if outcome == WAIT_OBJECT_0 {
        child
            .wait()
            .ok()
            .and_then(|status| status.code())
            .unwrap_or(125)
    } else {
        125
    };
    unsafe { TerminateJobObject(job.0, 125) };
    let _ = child.wait();
    // Root exit is not full-tree clearance. Retain the job/release until the
    // kernel reports every associated process stopped, including orphan children.
    while active(job.0)? != 0 {
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(job);
    Ok(code)
}
#[path = "managed_windows_controls.rs"]
mod controls;
pub use controls::{cleanup, host_barrier, host_check, inventory, protection, status};

#[cfg(test)]
mod tests {
    use super::*;
    fn assert_job_empty(job: &Owned) {
        // Process wait and Job Object accounting are independent kernel
        // observations. Require a fresh zero count, as managed run does.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let count = active(job.0).unwrap();
            if count == 0 {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "job still owns {count} processes"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn suspended_fixture(marker: &std::path::Path) -> std::process::Child {
        let program = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        Command::new(program)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "Set-Content -LiteralPath '{}' -Value 'started'",
                    marker.display().to_string().replace('\'', "''")
                ),
            ])
            .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap()
    }
    #[test]
    fn kernel_creation_gate_retains_suspension_and_refusal_cannot_execute_child() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("must-not-run");
        let owner = Process::open(std::process::id()).unwrap();
        let name = format!("Global\\NessieCustody-{}", nonce().unwrap());
        let job = job_with_service(&name, &owner.sid, &owner.sid).unwrap();
        let mut child = suspended_fixture(&marker);
        assert_eq!(
            unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) },
            1
        );
        assert_eq!(active(job.0).unwrap(), 1);
        let created = Process::open(child.id()).unwrap();
        assert!(created.alive());
        std::thread::sleep(Duration::from_millis(50));
        assert!(!marker.exists());
        child.kill().unwrap();
        child.wait().unwrap();
        assert_job_empty(&job);
        assert!(!marker.exists());
    }
    #[test]
    fn child_executes_only_after_explicit_native_resume_inside_the_job() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("started");
        let owner = Process::open(std::process::id()).unwrap();
        let name = format!("Global\\NessieCustody-{}", nonce().unwrap());
        let job = job_with_service(&name, &owner.sid, &owner.sid).unwrap();
        let mut child = suspended_fixture(&marker);
        assert_eq!(
            unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) },
            1
        );
        assert!(!marker.exists());
        assert!(resume(&child));
        assert!(child.wait().unwrap().success());
        assert!(marker.exists());
        assert_job_empty(&job);
    }
    #[test]
    fn unsigned_managed_entry_cannot_launch_even_a_harmless_command() {
        assert!(run(&["--version".into()]).is_err());
        assert!(inventory(&"a".repeat(64)).is_err());
        assert!(host_barrier(&"a".repeat(64)).is_err());
        assert_ne!(nonce().unwrap(), nonce().unwrap());
    }
}
