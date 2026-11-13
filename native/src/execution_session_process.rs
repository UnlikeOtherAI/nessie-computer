//! Move only an isolated SYSTEM creator into the target session. No handles,
//! user secrets or arbitrary arguments are inherited across Windows sessions.
use crate::execution_spawn_security::{token, wide, Attributes, Security};
use nessie_windows_common::{
    custody::REJECTED,
    process::{Owned, Process},
    release::Release,
};
use std::mem::size_of;
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_ALREADY_EXISTS},
    Security::{SetTokenInformation, TokenSessionId, TOKEN_DUPLICATE, TOKEN_QUERY},
    System::{
        JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{
            CreateProcessAsUserW, GetCurrentProcess, OpenProcessToken, ResumeThread,
            CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
            EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION, STARTUPINFOEXW, STARTUPINFOW,
        },
    },
};
pub struct Host {
    pub process: Process,
    pub job_name: String,
    job: Owned,
    thread: Owned,
    _process: Owned,
}
impl Host {
    pub fn resume(&self) -> Result<(), String> {
        if unsafe { ResumeThread(self.thread.0) } == u32::MAX {
            return Err(REJECTED.into());
        }
        Ok(())
    }
    pub fn stop(&self) {
        unsafe { TerminateJobObject(self.job.0, 125) };
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        self.stop();
    }
}
pub fn spawn(release: &Release, session: u32, nonce: &str) -> Result<Host, String> {
    let own = Process::open(std::process::id())?;
    if own.sid != "S-1-5-18"
        || own.session != 0
        || session == 0
        || session == u32::MAX
        || !nessie_windows_common::custody::valid_nonce(nonce)
    {
        return Err(REJECTED.into());
    }
    let service = nessie_windows_common::service_channel::service_account_sid()?;
    let security = Security::new(&format!(
        "O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;{service})(A;;0x00121000;;;AU)"
    ))?;
    let thread_security = Security::new(&format!(
        "O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;{service})(A;;0x00120800;;;AU)"
    ))?;
    let private = Security::new(&format!("O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;{service})"))?;
    let job_name = format!(r"Global\NessieCustodyHost-{nonce}");
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
    let mut original = std::ptr::null_mut();
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_QUERY,
            &mut original,
        )
    } == 0
    {
        return Err(REJECTED.into());
    }
    let original = Owned(original);
    let selected = token(&original, &service)?;
    if unsafe {
        SetTokenInformation(
            selected.0,
            TokenSessionId,
            (&session as *const u32).cast(),
            size_of::<u32>() as u32,
        )
    } == 0
    {
        return Err(REJECTED.into());
    }
    let image = release.runtime.native_helper.to_str().ok_or(REJECTED)?;
    if image.contains('"') {
        return Err(REJECTED.into());
    }
    let mut command = wide(&format!("\"{image}\" t3-execution-session-host {nonce}"));
    let system = nessie_windows_common::update_admission::known_folder(
        &windows_sys::Win32::UI::Shell::FOLDERID_Windows,
    )?;
    let mut environment = wide(&format!("SystemRoot={}\0", system.display()));
    let mut attributes = Attributes::new(Vec::new(), job.0, None)?;
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attributes.bytes.as_mut_ptr().cast();
    let mut created: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe {
        CreateProcessAsUserW(
            selected.0,
            wide(image).as_ptr(),
            command.as_mut_ptr(),
            &security.attributes(false),
            &thread_security.attributes(false),
            0,
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
    let process = Owned(created.hProcess);
    let thread = Owned(created.hThread);
    let actual = Process::open(created.dwProcessId)?;
    let host = Host {
        process: actual,
        job_name,
        job,
        thread,
        _process: process,
    };
    nessie_windows_common::execution_isolation::verify(&host.process)?;
    if host.process.sid != "S-1-5-18" || host.process.session != session {
        return Err(REJECTED.into());
    }
    Ok(host)
}
