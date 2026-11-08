//! `job-run -- <program> [arguments…]`: run one coding agent so that its whole
//! process tree dies with it.
//!
//! A coding session's host starts the agent through this command on Windows.
//! The helper creates a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`,
//! starts the program suspended, assigns it to the job and only then lets it
//! run, so no instruction of the agent's executes outside the job and every
//! process it starts — a test server, a watcher, a `start /b` that its parent
//! has long since forgotten — is in the job too. The helper holds the job's
//! only handle. When it exits, for any reason, Windows closes that handle and
//! kills everything still in the job. That is the containment `taskkill /T`
//! cannot give: `/T` walks parent ids at the moment it runs, so it misses a
//! grandchild whose parent already exited.
//!
//! The helper exits when the program does, with the program's own exit code,
//! and stdin, stdout and stderr pass straight through: the host speaks to the
//! agent exactly as it would without the helper between them. It also holds
//! its own parent open, and when that process — the session host — dies, it
//! terminates the job at once, so a host that crashes never leaves an agent
//! editing a working tree nobody is watching.
//!
//! Only Windows has Job Objects. Every other host answers
//! `EXECUTOR_NATIVE_UNSUPPORTED_PLATFORM`; POSIX hosts contain the agent with a
//! process group, a descendant sweep and, on Linux, a systemd user unit.

use crate::protocol::NativeError;

#[cfg_attr(windows, allow(dead_code))]
pub const UNSUPPORTED: &str = "EXECUTOR_NATIVE_UNSUPPORTED_PLATFORM";
/// The job could not be created or configured, or the program could not be
/// placed in it. The program never ran.
#[cfg_attr(not(windows), allow(dead_code))]
pub const CONTAINMENT_FAILED: &str = "EXECUTOR_JOB_CONTAINMENT_FAILED";
/// `CreateProcessW` refused the program: missing, not executable, or an
/// argv Windows cannot express.
#[cfg_attr(not(windows), allow(dead_code))]
pub const SPAWN_FAILED: &str = "EXECUTOR_JOB_SPAWN_FAILED";
/// The process that asked for this run was already gone, so nothing would be
/// left to end the job when it should end.
#[cfg_attr(not(windows), allow(dead_code))]
pub const PARENT_GONE: &str = "EXECUTOR_JOB_PARENT_GONE";

/// Runs the program to completion and answers the code the helper exits with.
pub fn run(argv: &[String]) -> Result<i32, NativeError> {
    run_mode(argv, false)
}
pub fn run_authorized(argv: &[String]) -> Result<i32, NativeError> {
    run_mode(argv, true)
}
fn run_mode(argv: &[String], authorized: bool) -> Result<i32, NativeError> {
    #[cfg(all(windows, not(debug_assertions)))]
    let lease = crate::managed_windows::acquire_host()?;
    let result = imp::run(argv, authorized);
    #[cfg(all(windows, not(debug_assertions)))]
    crate::managed_windows::release_host(&lease)?;
    result
}

#[cfg(not(windows))]
mod imp {
    use super::{NativeError, UNSUPPORTED};

    pub fn run(_argv: &[String], _authorized: bool) -> Result<i32, NativeError> {
        Err(NativeError::new(UNSUPPORTED))
    }
}

#[cfg(windows)]
pub(crate) mod imp {
    use super::{NativeError, CONTAINMENT_FAILED, PARENT_GONE, SPAWN_FAILED};
    use std::os::windows::io::{AsRawHandle, BorrowedHandle};
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command};
    use windows_sys::Win32::Foundation::{
        CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, Thread32First, Thread32Next,
        PROCESSENTRY32W, TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetProcessTimes, OpenProcess, OpenThread, ResumeThread,
        WaitForMultipleObjects, CREATE_NO_WINDOW, CREATE_SUSPENDED, INFINITE,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, THREAD_SUSPEND_RESUME,
    };

    /// The exit code a job ends with when the helper, not the program, ends it.
    const ENDED_BY_HELPER: u32 = 1;

    /// A handle this module opened and alone closes.
    pub(crate) struct Owned(pub HANDLE);

    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    fn kill_on_close_job() -> Result<Owned, NativeError> {
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(NativeError::new(CONTAINMENT_FAILED));
        }
        let job = Owned(job);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(NativeError::new(CONTAINMENT_FAILED));
        }
        Ok(job)
    }

    fn created_at(process: HANDLE) -> Option<u64> {
        let mut times = [FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        }; 4];
        let [created, exited, kernel, user] = &mut times;
        if unsafe { GetProcessTimes(process, created, exited, kernel, user) } == 0 {
            return None;
        }
        Some((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    fn parent_id() -> Option<u32> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let snapshot = Owned(snapshot);
        let own = std::process::id();
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = unsafe { Process32FirstW(snapshot.0, &mut entry) } != 0;
        while more {
            if entry.th32ProcessID == own {
                return Some(entry.th32ParentProcessID);
            }
            more = unsafe { Process32NextW(snapshot.0, &mut entry) } != 0;
        }
        None
    }

    /// The process that started this helper, held open for as long as the
    /// program runs. A parent id is only a number and numbers are reused, so a
    /// process created after this helper cannot be the one that started it.
    pub(crate) fn parent_process() -> Result<Owned, NativeError> {
        let parent = parent_id().ok_or(NativeError::new(PARENT_GONE))?;
        let handle = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                parent,
            )
        };
        if handle.is_null() {
            return Err(NativeError::new(PARENT_GONE));
        }
        let handle = Owned(handle);
        match (
            created_at(handle.0),
            created_at(unsafe { GetCurrentProcess() }),
        ) {
            (Some(parent_created), Some(own_created)) if parent_created <= own_created => {
                Ok(handle)
            }
            _ => Err(NativeError::new(PARENT_GONE)),
        }
    }

    /// Lets a program started with `CREATE_SUSPENDED` run. It has exactly one
    /// thread, which nothing but this helper can have resumed; the standard
    /// library keeps that thread's handle to itself on a stable toolchain, so
    /// the thread is found by its owning process in a thread snapshot.
    pub(crate) fn resume(child: &Child) -> bool {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }
        let snapshot = Owned(snapshot);
        let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut resumed = false;
        let mut more = unsafe { Thread32First(snapshot.0, &mut entry) } != 0;
        while more {
            if entry.th32OwnerProcessID == child.id() {
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if thread.is_null() {
                    return false;
                }
                let thread = Owned(thread);
                if unsafe { ResumeThread(thread.0) } == u32::MAX {
                    return false;
                }
                resumed = true;
            }
            more = unsafe { Thread32Next(snapshot.0, &mut entry) } != 0;
        }
        resumed
    }

    /// Ends a program that must not run: it is still suspended and outside any
    /// job, so killing it is the whole of the cleanup.
    fn abandon(mut child: Child, code: &'static str) -> NativeError {
        let _ = child.kill();
        let _ = child.wait();
        NativeError::new(code)
    }

    fn terminate_job(job: &Owned) -> Result<(), NativeError> {
        // The authorized relay owns a duplicate handle while waiting for input.
        // Closing only the main handle cannot trigger kill-on-close in that state.
        // End descendants before asking the service for independent clearance.
        if unsafe { TerminateJobObject(job.0, ENDED_BY_HELPER) } == 0 {
            return Err(NativeError::new(CONTAINMENT_FAILED));
        }
        Ok(())
    }

    pub fn run(argv: &[String], authorized: bool) -> Result<i32, NativeError> {
        let (program, arguments) = argv.split_first().ok_or(NativeError::new(SPAWN_FAILED))?;
        let parent = parent_process()?;
        let job = kill_on_close_job()?;
        // No console window of its own; stdio is inherited explicitly, so the
        // pipes the host holds are the program's stdin, stdout and stderr.
        let mut channel = if authorized {
            Some(crate::session_effect::inherited()?)
        } else {
            None
        };
        let launch = if let Some(ref mut receiver) = channel {
            Some(receiver.launch(argv)?)
        } else {
            None
        };
        let mut command = Command::new(program);
        command
            .args(arguments)
            .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
        if authorized {
            command.stdin(std::process::Stdio::piped());
        }
        if let (Some(receiver), Some(frame)) = (&mut channel, &launch) {
            receiver.consume(frame)?;
        }
        let mut child = command
            .spawn()
            .map_err(|_| NativeError::new(SPAWN_FAILED))?;
        let process = child.as_raw_handle() as HANDLE;
        if unsafe { AssignProcessToJobObject(job.0, process) } == 0 {
            return Err(abandon(child, CONTAINMENT_FAILED));
        }
        if let (Some(receiver), Some(frame)) = (&mut channel, &launch) {
            if receiver.consume(frame).is_err() {
                return Err(abandon(child, crate::session_effect::REFUSED));
            }
        }
        if !resume(&child) {
            return Err(abandon(child, SPAWN_FAILED));
        }
        if let (Some(mut receiver), Some(frame)) = (channel, launch) {
            if receiver.outcome(&frame, "accepted").is_err() {
                return Err(abandon(child, crate::session_effect::REFUSED));
            }
            let input = child.stdin.take().ok_or(NativeError::new(SPAWN_FAILED))?;
            let job_for_relay = unsafe { BorrowedHandle::borrow_raw(job.0 as _) }
                .try_clone_to_owned()
                .map_err(|_| NativeError::new(CONTAINMENT_FAILED))?;
            std::thread::spawn(move || {
                if receiver.relay(input, false).is_err() {
                    unsafe {
                        TerminateJobObject(job_for_relay.as_raw_handle() as HANDLE, ENDED_BY_HELPER)
                    };
                }
            });
        }
        let handles = [process, parent.0];
        let signalled =
            unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, INFINITE) };
        let mut child = child;
        if signalled == WAIT_OBJECT_0 {
            let code = child
                .wait()
                .ok()
                .and_then(|status| status.code())
                .unwrap_or(ENDED_BY_HELPER as i32);
            // A relay may still hold the job open after the root exits. Explicit
            // termination closes that gap without treating root exit as clearance.
            terminate_job(&job)?;
            drop(job);
            return Ok(code);
        }
        // The session host is gone, or the wait itself failed: either way no
        // one is left to end this job later, so it ends now.
        terminate_job(&job)?;
        let _ = child.wait();
        Ok(ENDED_BY_HELPER as i32)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
        use windows_sys::Win32::System::Threading::WaitForSingleObject;

        #[test]
        fn explicit_job_termination_ends_children_while_the_relay_retains_a_handle() {
            let job = kill_on_close_job().unwrap();
            let relay = unsafe { BorrowedHandle::borrow_raw(job.0 as _) }
                .try_clone_to_owned()
                .unwrap();
            let program = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join("System32/cmd.exe");
            // A suspended synthetic child needs no provider, credentials or host
            // authority. This verifies a kernel primitive, not release admission.
            let mut child = Command::new(program)
                .args(["/d", "/c", "exit 0"])
                .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
                .spawn()
                .unwrap();
            assert_ne!(
                unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) },
                0
            );
            assert_eq!(
                unsafe { WaitForSingleObject(child.as_raw_handle() as HANDLE, 0) },
                WAIT_TIMEOUT
            );
            terminate_job(&job).unwrap();
            assert_eq!(
                unsafe { WaitForSingleObject(child.as_raw_handle() as HANDLE, 5_000) },
                WAIT_OBJECT_0
            );
            child.wait().unwrap();
            // Keep the relay handle alive through the exit observation.
            drop(relay);
        }
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    #[test]
    fn only_windows_runs_a_job() {
        assert_eq!(
            super::run(&["true".to_owned()]).map_err(|error| error.code),
            Err(super::UNSUPPORTED)
        );
    }
}
