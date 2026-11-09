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

/// How long an ending process may take to read as a zombie or as gone.
const ENDING_READS: u32 = 100;

/// The full kernel record; `None` once the process is gone.
fn record(pid: i32) -> Result<Option<libc::proc_bsdinfo>, NativeError> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    if unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size) } != size {
        return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) { Ok(None) }
            else { Err(refused()) };
    }
    let info = unsafe { info.assume_init() };
    if info.pbi_pid != pid as u32 { return Err(refused()); }
    Ok(Some(info))
}

/// The image path, or the errno that refused it.
fn image(pid: i32) -> Result<PathBuf, Option<i32>> {
    let mut path = vec![0_i8; 4096]; // PROC_PIDPATHINFO_MAXSIZE
    let read = unsafe { proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    if read <= 0 { return Err(std::io::Error::last_os_error().raw_os_error()); }
    unsafe { CStr::from_ptr(path.as_ptr()) }.to_str().map(PathBuf::from).map_err(|_| None)
}

pub fn information(pid: i32) -> Result<Option<Process>, NativeError> {
    if pid <= 0 { return Err(refused()); }
    let mut reads = 0;
    loop {
        let Some(info) = record(pid)? else { return Ok(None) };
        let zombie = info.pbi_status == 5; // sys/proc.h SZOMB
        let executable = if zombie { PathBuf::new() } else {
            match image(pid) {
                Ok(path) => path,
                // XNU releases an ending process's image before it marks the
                // process a zombie, and answers ESRCH in between. Read the
                // record again until it is a zombie or gone: helpers that
                // other apps start and end many times a second otherwise
                // refused every snapshot, and each refusal ended a runtime.
                Err(Some(libc::ESRCH)) if reads < ENDING_READS => {
                    reads += 1;
                    std::thread::sleep(std::time::Duration::from_millis(1));
                    continue;
                }
                // A live process whose image was replaced on disk (a browser
                // helper after its app updated) has no path. It cannot be a
                // product process, so it stays in the tree with no executable
                // rather than hiding it.
                Err(Some(libc::ENOENT)) if !product_name(command(&info.pbi_comm)?) => PathBuf::new(),
                Err(_) => return Err(refused()),
            }
        };
        if !zombie && !executable.as_os_str().is_empty() && !executable.is_absolute() { return Err(refused()); }
        return Ok(Some(Process { pid, parent_pid: info.pbi_ppid as i32, group: info.pbi_pgid as i32,
            uid: info.pbi_uid, started_at: kernel_context::started(&info)?, executable, zombie }));
    }
}

fn command(name: &[libc::c_char]) -> Result<&str, NativeError> {
    if !name.contains(&0) { return Err(refused()); }
    unsafe { CStr::from_ptr(name.as_ptr()) }.to_str().map_err(|_| refused())
}

/// Names a Node or product process may carry. Such a process is observed in
/// full or the snapshot is refused.
fn product_name(name: &str) -> bool {
    ["node", "nodejs", "Nessie", "nessie", "Nessie Executor"].contains(&name) || name.starts_with("nessie-executor")
}

/// Every process id, refusing a filled buffer: a truncated list cannot establish absence.
fn pids() -> Result<Vec<i32>, NativeError> {
    let mut pids = vec![0_i32; 65_536];
    let capacity = (pids.len() * std::mem::size_of::<i32>()) as i32;
    let bytes = unsafe { proc_listpids(1, 0, pids.as_mut_ptr().cast(), capacity) };
    if bytes <= 0 || bytes >= capacity || bytes % 4 != 0 { return Err(refused()); }
    Ok(pids.into_iter().take(bytes as usize / 4).filter(|pid| *pid > 0).collect())
}

/// The short record, readable for every account's process; `None` once it is gone.
/// The full record is refused (EPERM) for other users, including Root daemons.
fn short(pid: i32) -> Result<Option<libc::proc_bsdshortinfo>, NativeError> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdshortinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdshortinfo>() as i32;
    if unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDT_SHORTBSDINFO, 0, info.as_mut_ptr().cast(), size) } != size {
        if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) { return Ok(None); }
        return Err(refused());
    }
    Ok(Some(unsafe { info.assume_init() }))
}

/// The process groups that still hold a live process of any account. Unlike
/// `all`, which keeps to the caller's account, this sees a descendant another
/// account's command left behind, so a Root caller can rule out a surviving group.
pub fn live_groups() -> Result<std::collections::HashSet<i32>, NativeError> {
    let mut groups = std::collections::HashSet::new();
    for pid in pids()? {
        // sys/proc.h SZOMB
        if let Some(info) = short(pid)? { if info.pbsi_status != 5 { groups.insert(info.pbsi_pgid as i32); } }
    }
    Ok(groups)
}

pub fn all() -> Result<Vec<Process>, NativeError> {
    let own = unsafe { libc::getuid() };
    let mut found = Vec::new();
    for pid in pids()? {
        let Some(info) = short(pid)? else { continue };
        if info.pbsi_uid != own {
            if info.pbsi_uid != 0 { continue; }
            // Root system daemons are irrelevant; an elevated Node/product
            // process can access private credentials and must be observed.
            if !product_name(command(&info.pbsi_comm)?) { continue; }
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

    #[test]
    fn snapshot_includes_this_process_while_root_daemons_exist() {
        // launchd is always a Root process whose full record is refused to
        // ordinary users; the snapshot must still succeed and see itself.
        let pid = std::process::id() as i32;
        let table = all().unwrap();
        assert!(table.iter().any(|process| process.pid == pid && process.executable.is_absolute()));
        assert!(table.iter().all(|process| process.uid == unsafe { libc::getuid() } || process.uid == 0));
    }

    /// Read throughout its exit, as a snapshot reads the helpers other apps
    /// end, a process is live, a zombie or gone, never refused.
    #[test]
    fn a_process_read_throughout_its_exit_is_never_refused() {
        for _ in 0..300 {
            let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
            let pid = child.id() as i32;
            while information(pid).unwrap().is_some_and(|process| !process.zombie) {}
            child.wait().unwrap();
        }
    }

    #[test]
    fn snapshots_hold_while_processes_start_and_end() {
        use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
        let stop = Arc::new(AtomicBool::new(false));
        let churn = { let stop = stop.clone(); std::thread::spawn(move || while !stop.load(Ordering::Relaxed) {
            std::process::Command::new("/usr/bin/true").status().unwrap();
        }) };
        let started = std::time::Instant::now();
        let mut snapshots = Ok(0);
        while snapshots.is_ok() && started.elapsed() < std::time::Duration::from_secs(3) {
            snapshots = all().and_then(|_| live_groups()).map(|_| snapshots.unwrap() + 1);
        }
        stop.store(true, Ordering::Relaxed);
        churn.join().unwrap();
        assert!(snapshots.unwrap() > 0);
    }

    #[test]
    fn product_names_are_never_unnamed() {
        for name in ["node", "nodejs", "Nessie", "Nessie Executor", "nessie-executor-native"] {
            assert!(product_name(name), "{name}");
        }
        for name in ["browser_crashpa", "launchd", "nodes", ""] { assert!(!product_name(name), "{name}"); }
        assert!(command(&[b'a' as libc::c_char; 4]).is_err());
    }
}
