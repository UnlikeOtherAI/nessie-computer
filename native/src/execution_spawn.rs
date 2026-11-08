//! Fixed executable/argument creation for the SYSTEM execution listener.
use super::execution_spawn_security::{token, wide, Attributes, Security};
use nessie_windows_common::{
    custody::REJECTED,
    execution_creator::CompanionRole,
    process::{Owned, Process},
    release::Release,
};
use std::{
    fs::File,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle},
};
use windows_sys::Win32::{
    Foundation::{
        DuplicateHandle, GetLastError, DUPLICATE_CLOSE_SOURCE, DUPLICATE_SAME_ACCESS,
        ERROR_ALREADY_EXISTS, HANDLE, WAIT_OBJECT_0,
    },
    System::{
        JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Pipes::CreatePipe,
        RemoteDesktop::WTSQueryUserToken,
        Threading::{
            CreateProcessAsUserW, GetCurrentProcess, GetExitCodeProcess, OpenProcess, ResumeThread,
            WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
            EXTENDED_STARTUPINFO_PRESENT, PROCESS_CREATE_PROCESS, PROCESS_DUP_HANDLE,
            PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW,
        },
    },
};
pub struct Child {
    pub process: Process,
    pub job_name: String,
    pub stdin: Option<File>,
    pub stdout: Option<File>,
    pub stderr: Option<File>,
    job: Owned,
    thread: Owned,
    _process: Owned,
}
impl Child {
    pub fn duplicate_job(&self) -> Result<Owned, String> {
        let mut copy = std::ptr::null_mut();
        if unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                self.job.0,
                GetCurrentProcess(),
                &mut copy,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        } == 0
        {
            return Err(REJECTED.into());
        }
        Ok(Owned(copy))
    }
    pub fn resume(&self) -> Result<(), String> {
        if unsafe { ResumeThread(self.thread.0) } == u32::MAX {
            return Err(REJECTED.into());
        }
        Ok(())
    }
    pub fn exit_code(&self) -> Result<Option<u32>, String> {
        if unsafe { WaitForSingleObject(self._process.0, 0) } != WAIT_OBJECT_0 {
            return Ok(None);
        }
        let mut code = 0;
        if unsafe { GetExitCodeProcess(self._process.0, &mut code) } == 0 {
            return Err(REJECTED.into());
        }
        Ok(Some(code))
    }
    pub fn stop(&self) -> Result<(), String> {
        if unsafe { TerminateJobObject(self.job.0, 125) } == 0 {
            return Err(REJECTED.into());
        }
        Ok(())
    }
}
impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
fn pipe(security: &Security) -> Result<(File, File), String> {
    let (mut read, mut write) = (std::ptr::null_mut(), std::ptr::null_mut());
    if unsafe { CreatePipe(&mut read, &mut write, &security.attributes(true), 65536) } == 0 {
        return Err(REJECTED.into());
    }
    Ok((unsafe { File::from_raw_handle(read) }, unsafe {
        File::from_raw_handle(write)
    }))
}
struct Remote {
    process: Owned,
    handles: Vec<HANDLE>,
}
impl Drop for Remote {
    fn drop(&mut self) {
        for handle in &self.handles {
            let mut local = std::ptr::null_mut();
            if unsafe {
                DuplicateHandle(
                    self.process.0,
                    *handle,
                    GetCurrentProcess(),
                    &mut local,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS | DUPLICATE_CLOSE_SOURCE,
                )
            } != 0
            {
                drop(Owned(local));
            }
        }
    }
}
fn inherited(
    handles: &[HANDLE],
    parent: Option<u32>,
) -> Result<(Vec<HANDLE>, Option<Remote>), String> {
    let Some(parent) = parent else {
        return Ok((handles.to_vec(), None));
    };
    let process =
        Owned(unsafe { OpenProcess(PROCESS_CREATE_PROCESS | PROCESS_DUP_HANDLE, 0, parent) });
    if process.0.is_null() {
        return Err(REJECTED.into());
    }
    let mut remote = Remote {
        process,
        handles: Vec::new(),
    };
    for handle in handles {
        let mut copy = std::ptr::null_mut();
        if unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                *handle,
                remote.process.0,
                &mut copy,
                0,
                1,
                DUPLICATE_SAME_ACCESS,
            )
        } == 0
        {
            return Err(REJECTED.into());
        }
        remote.handles.push(copy);
    }
    Ok((remote.handles.clone(), Some(remote)))
}
fn quote(value: &str) -> String {
    // Only immutable installed paths reach this function. Reject embedded quotes
    // rather than accepting a second Windows command line through path text.
    format!("\"{value}\"")
}
pub fn spawn(
    release: &Release,
    owner: &str,
    session: u32,
    nonce: &str,
    role: Option<&CompanionRole>,
    parent: Option<u32>,
) -> Result<Child, String> {
    if !nessie_windows_common::custody::valid_nonce(nonce) || role.is_some() != parent.is_some() {
        return Err(REJECTED.into());
    }
    if nessie_windows_common::process::session_owner(session)? != owner {
        return Err(REJECTED.into());
    }
    let own = Process::open(std::process::id())?;
    if own.sid != "S-1-5-18" || own.session != 0 {
        return Err(REJECTED.into());
    }
    let service = nessie_windows_common::service_channel::service_account_sid()?;
    let process_security = Security::new(&format!(
        "O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;{service})(A;;0x00121000;;;AU)"
    ))?;
    let thread_security = Security::new(&format!(
        "O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;{service})(A;;0x00120800;;;AU)"
    ))?;
    let private = Security::new(&format!("O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;{service})"))?;
    let job_name = format!(r"Global\NessieCustody-{nonce}");
    let job =
        Owned(unsafe { CreateJobObjectW(&private.attributes(false), wide(&job_name).as_ptr()) });
    if job.0.is_null() || unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        return Err(REJECTED.into());
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(REJECTED.into());
    }
    let (input, stdin) = pipe(&private)?;
    let (stdout, output) = pipe(&private)?;
    let (stderr, error) = pipe(&private)?;
    let (handles, remote) = inherited(
        &[
            input.as_raw_handle(),
            output.as_raw_handle(),
            error.as_raw_handle(),
        ],
        parent,
    )?;
    let mut attributes =
        Attributes::new(handles.clone(), job.0, remote.as_ref().map(|r| r.process.0))?;
    let mut user = std::ptr::null_mut();
    if unsafe { WTSQueryUserToken(session, &mut user) } == 0 {
        return Err(REJECTED.into());
    }
    let user = Owned(user);
    let user = token(&user, &service)?;
    let executable = if role.is_none() {
        &release.runtime.node_executable
    } else {
        &release.runtime.native_helper
    };
    let image = executable.to_str().ok_or(REJECTED)?;
    let bundle = release.runtime.bundle();
    let bundle = bundle.to_str().ok_or(REJECTED)?;
    if image.contains('"') || bundle.contains('"') {
        return Err(REJECTED.into());
    }
    let args = match role {
        None => format!("{} {} t3-session-runtime", quote(image), quote(bundle)),
        Some(role) => format!("{} {}", quote(image), role.arguments().join(" ")),
    };
    let mut args = wide(&args);
    let mut desktop = wide(r"winsta0\default");
    let system = nessie_windows_common::update_admission::known_folder(
        &windows_sys::Win32::UI::Shell::FOLDERID_Windows,
    )?;
    let mut environment = wide(&format!(
        "NESSIE_EXECUTOR_PACKAGED_CLI=1\0PATH={}\\System32\0SystemRoot={}\0",
        system.display(),
        system.display()
    ));
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.lpDesktop = desktop.as_mut_ptr();
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0];
    startup.StartupInfo.hStdOutput = handles[1];
    startup.StartupInfo.hStdError = handles[2];
    startup.lpAttributeList = attributes.bytes.as_mut_ptr().cast();
    let mut created: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe {
        CreateProcessAsUserW(
            user.0,
            wide(image).as_ptr(),
            args.as_mut_ptr(),
            &process_security.attributes(false),
            &thread_security.attributes(false),
            1,
            CREATE_SUSPENDED
                | CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_mut_ptr().cast(),
            wide(release.runtime.root.to_str().ok_or(REJECTED)?).as_ptr(),
            (&startup as *const STARTUPINFOEXW).cast::<STARTUPINFOW>(),
            &mut created,
        )
    } == 0
    {
        return Err(REJECTED.into());
    }
    let handle = Owned(created.hProcess);
    let thread = Owned(created.hThread);
    drop(remote);
    drop(input);
    drop(output);
    drop(error);
    let process = Process::open(created.dwProcessId)?;
    let child = Child {
        process,
        job_name,
        stdin: Some(stdin),
        stdout: Some(stdout),
        stderr: Some(stderr),
        job,
        thread,
        _process: handle,
    };
    nessie_windows_common::execution_isolation::verify(&child.process)?;
    if child.process.sid != owner || child.process.session != session || child.process.elevated {
        return Err(REJECTED.into());
    }
    Ok(child)
}
