//! Independent libproc generations and retained kernel exit observations.
use crate::{kernel_context, protocol::NativeError};
use std::{ffi::CStr, fs::File, os::fd::{AsRawFd, FromRawFd}, path::PathBuf};

extern "C" {
    fn proc_listpids(kind: u32, info: u32, buffer: *mut libc::c_void, size: i32) -> i32;
    fn proc_pidpath(pid: i32, buffer: *mut libc::c_void, size: u32) -> i32;
}
fn refused() -> NativeError { NativeError::new("EXECUTOR_MACOS_PROCESS_UNVERIFIED") }

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Process {
    pub pid: i32,
    pub parent_pid: i32,
    pub group: i32,
    pub uid: u32,
    pub started_at: String,
    pub executable: PathBuf,
    pub zombie: bool,
}

pub fn information(pid: i32) -> Result<Option<Process>, NativeError> {
    if pid <= 0 { return Err(refused()); }
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    if unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size) } != size {
        return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) { Ok(None) }
            else { Err(refused()) };
    }
    let info = unsafe { info.assume_init() };
    let zombie = info.pbi_status == 5; // sys/proc.h SZOMB
    let mut path = vec![0_i8; 4096]; // PROC_PIDPATHINFO_MAXSIZE
    let read = unsafe { proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    if read <= 0 && !zombie { return Err(refused()); }
    let executable = if zombie { PathBuf::new() } else {
        PathBuf::from(unsafe { CStr::from_ptr(path.as_ptr()) }.to_str().map_err(|_| refused())?)
    };
    if info.pbi_pid != pid as u32 || !zombie && !executable.is_absolute() { return Err(refused()); }
    Ok(Some(Process { pid, parent_pid: info.pbi_ppid as i32, group: info.pbi_pgid as i32,
        uid: info.pbi_uid, started_at: kernel_context::birth(pid)?, executable, zombie }))
}

pub fn all() -> Result<Vec<Process>, NativeError> {
    // Refuse a filled buffer; a truncated process list cannot establish absence.
    let mut pids = vec![0_i32; 65_536];
    let capacity = (pids.len() * std::mem::size_of::<i32>()) as i32;
    let bytes = unsafe { proc_listpids(1, 0, pids.as_mut_ptr().cast(), capacity) };
    if bytes <= 0 || bytes >= capacity || bytes % 4 != 0 { return Err(refused()); }
    let mut found = Vec::new();
    for pid in pids.into_iter().take(bytes as usize / 4).filter(|pid| *pid > 0) {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        if unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size) } != size {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) { continue; }
            return Err(refused());
        }
        let info = unsafe { info.assume_init() };
        if info.pbi_uid != unsafe { libc::getuid() } {
            if info.pbi_uid != 0 { continue; }
            // Root system daemons are irrelevant; an elevated Node/product
            // process can access private credentials and must be observed.
            let name = unsafe { CStr::from_ptr(info.pbi_comm.as_ptr().cast()) }.to_str().map_err(|_| refused())?;
            if !["node", "nodejs", "Nessie", "nessie", "Nessie Executor"].contains(&name)
                && !name.starts_with("nessie-executor") { continue; }
        }
        if let Some(process) = information(pid)? { found.push(process); }
    }
    Ok(found)
}

pub struct Observations(File);
impl Observations {
    pub fn new() -> Result<Self, NativeError> {
        let descriptor = unsafe { libc::kqueue() };
        if descriptor < 0 { return Err(refused()); }
        let file = unsafe { File::from_raw_fd(descriptor) };
        if unsafe { libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 { return Err(refused()); }
        Ok(Self(file))
    }
    pub fn retain(&self, process: &Process) -> Result<(), NativeError> {
        let event = libc::kevent { ident: process.pid as libc::uintptr_t, filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_CLEAR, fflags: libc::NOTE_EXIT, data: 0, udata: std::ptr::null_mut() };
        if unsafe { libc::kevent(self.0.as_raw_fd(), &event, 1, std::ptr::null_mut(), 0, std::ptr::null()) } < 0
            || information(process.pid)?.as_ref().map(|live| &live.started_at) != Some(&process.started_at) {
            return Err(refused());
        }
        Ok(())
    }
    pub fn unchanged(&self) -> Result<(), NativeError> {
        let mut event = std::mem::MaybeUninit::<libc::kevent>::zeroed();
        let timeout = libc::timespec { tv_sec: 0, tv_nsec: 0 };
        if unsafe { libc::kevent(self.0.as_raw_fd(), std::ptr::null(), 0, event.as_mut_ptr(), 1, &timeout) } != 0 {
            return Err(refused());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_kernel_snapshot_retains_exact_generation() {
        let pid = std::process::id() as i32;
        let own = information(pid).unwrap().unwrap();
        assert_eq!(own.uid, unsafe { libc::getuid() });
        assert_eq!(own.started_at, kernel_context::birth(pid).unwrap());
        assert!(own.executable.is_absolute());
        let observations = Observations::new().unwrap();
        observations.retain(&own).unwrap();
        observations.unchanged().unwrap();
        assert!(information(i32::MAX).unwrap().is_none());
    }
}
