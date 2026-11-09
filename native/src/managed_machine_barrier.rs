//! Persistent machine admission inode: package upgrades never replace it.
use crate::protocol::NativeError;
use std::ffi::CStr;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[cfg(target_os = "linux")]
const ROOT: &str = "/var/lib/nessie-executor";
#[cfg(target_os = "macos")]
const ROOT: &str = "/Library/Application Support/Nessie Executor";
const FILE: &str = "custody-admission.lock";
#[cfg(target_os = "linux")]
pub const ROOT_RUNTIME: &str = "/var/lib/nessie-executor/root-runtime";
#[cfg(target_os = "macos")]
pub const ROOT_RUNTIME: &str = "/Library/Application Support/Nessie Executor/root-runtime";
const VERSION: &[u8] = b"nessie-custody-admission-v1\n";
fn refused() -> NativeError {
    NativeError::new("EXECUTOR_MACHINE_CUSTODY_UNVERIFIED")
}

fn trusted_directory(path: &Path) -> Result<(), NativeError> {
    let mut ancestor = Some(path);
    while let Some(directory) = ancestor {
        let entry = fs::symlink_metadata(directory).map_err(|_| refused())?;
        if !entry.is_dir()
            || entry.file_type().is_symlink()
            || entry.uid() != 0
            || entry.mode() & 0o022 != 0
        {
            return Err(refused());
        }
        ancestor = directory.parent();
    }
    Ok(())
}

fn open() -> Result<File, NativeError> {
    trusted_directory(Path::new(ROOT))?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(Path::new(ROOT).join(FILE))
        .map_err(|_| refused())?;
    let entry = file.metadata().map_err(|_| refused())?;
    if !entry.is_file()
        || entry.uid() != 0
        || entry.nlink() != 1
        || entry.mode() & 0o022 != 0
        || entry.len() != VERSION.len() as u64
    {
        return Err(refused());
    }
    let mut value = Vec::new();
    file.read_to_end(&mut value).map_err(|_| refused())?;
    if value != VERSION {
        return Err(refused());
    }
    Ok(file)
}

/// Only the trusted package's privileged install step creates this inode.
/// Existing state is verified, never chmodded, truncated, renamed or deleted.
pub fn install() -> Result<(), NativeError> {
    if unsafe { libc::getuid() } != 0 || unsafe { libc::geteuid() } != 0 {
        return Err(refused());
    }
    let root = Path::new(ROOT);
    if !root.exists() {
        trusted_directory(root.parent().ok_or_else(refused)?)?;
        std::fs::DirBuilder::new()
            .mode(0o755)
            .create(root)
            .map_err(|_| refused())?;
        fs::set_permissions(root, fs::Permissions::from_mode(0o755)).map_err(|_| refused())?;
        File::open(root.parent().unwrap())
            .map_err(|_| refused())?
            .sync_all()
            .map_err(|_| refused())?;
    }
    trusted_directory(root)?;
    let path = root.join(FILE);
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o644)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(mut file) => {
            file.set_permissions(fs::Permissions::from_mode(0o644))
                .map_err(|_| refused())?;
            file.write_all(VERSION).map_err(|_| refused())?;
            file.sync_all().map_err(|_| refused())?;
            File::open(root)
                .map_err(|_| refused())?
                .sync_all()
                .map_err(|_| refused())?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(refused()),
    }
    for path in [
        Path::new(ROOT_RUNTIME).to_path_buf(),
        Path::new(ROOT_RUNTIME).join("managed-runtimes"),
    ] {
        if !path.exists() {
            std::fs::DirBuilder::new()
                .mode(0o755)
                .create(&path)
                .map_err(|_| refused())?;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).map_err(|_| refused())?;
        }
        trusted_directory(&path)?;
    }
    open().map(|_| ())
}

pub struct MachineBarrier {
    _file: File,
}
impl MachineBarrier {
    pub fn acquire() -> Result<Self, NativeError> {
        Self::lock(open()?)
    }
    /// Waits up to `limit` while another holder finishes. Each native
    /// creation holds the barrier for milliseconds, so taking it at once
    /// refused any command that met another one's creation, and a runtime that
    /// met one while dropping its journal left that journal behind.
    pub fn wait(limit: Duration) -> Result<Self, NativeError> {
        let file = open()?;
        lock_within(&file, limit, "EXECUTOR_MACHINE_CUSTODY_BUSY")?;
        Ok(Self { _file: file })
    }
    fn lock(file: File) -> Result<Self, NativeError> {
        lock_within(&file, Duration::ZERO, "EXECUTOR_MACHINE_CUSTODY_BUSY")?;
        Ok(Self { _file: file })
    }
}

/// Takes an exclusive lock on `file`, retrying while another description holds
/// it until `limit` has passed; any other failure refuses at once.
pub(crate) fn lock_within(file: &File, limit: Duration, busy: &'static str) -> Result<(), NativeError> {
    let deadline = Instant::now() + limit;
    while unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        if std::io::Error::last_os_error().raw_os_error() != Some(libc::EWOULDBLOCK) || Instant::now() >= deadline {
            return Err(NativeError::new(busy));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

fn check_home(home: &Path, uid: u32) -> Result<(), NativeError> {
    if !crate::unix_account_state::needs_custody_inspection(home, uid).map_err(|_| refused())? {
        return Ok(());
    }
    if fs::canonicalize(home).map_err(|_| refused())? != home {
        return Err(refused());
    }
    let root = home.join(".nessie").join("personal-inference");
    if root
        .join("inventory-transition.json")
        .try_exists()
        .map_err(|_| refused())?
    {
        return Err(refused());
    }
    let guard = root.join("guard.json");
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(guard)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if root.join("profiles").exists() || root.join("native-writers").exists() {
                return Err(refused());
            }
            return Ok(());
        }
        Err(_) => return Err(refused()),
    };
    let metadata = file.metadata().map_err(|_| refused())?;
    if !metadata.is_file()
        || metadata.uid() != uid
        || metadata.nlink() != 1
        || metadata.mode() & 0o077 != 0
        || metadata.len() > 1024 * 1024
    {
        return Err(refused());
    }
    let state: serde_json::Value = serde_json::from_reader(file).map_err(|_| refused())?;
    if state["version"] != 1
        || state["protection"] != serde_json::Value::Null
        || !state["registrations"].is_array()
        || state["registrations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "credential_runtime")
    {
        return Err(NativeError::new("EXECUTOR_PERSONAL_CUSTODY_PROTECTED"));
    }
    // An unfinished credential deletion/helper read also keeps root execution
    // fenced. Absence is read positively; failed traversal is never absence.
    match fs::read_dir(root.join("native-writers")) {
        Ok(mut entries) => {
            if entries.next().is_some() {
                return Err(refused());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(refused()),
    }
    Ok(())
}

/// Called only for an elevated managed launch while the global lock is held.
pub fn refuse_protected_users() -> Result<(), NativeError> {
    if unsafe { libc::getuid() } != 0 {
        return Err(refused());
    }
    unsafe {
        libc::setpwent();
    }
    let result = (|| {
        let mut count = 0;
        loop {
            unsafe {
                *crate::unix_kernel::errno_address() = 0;
            }
            let entry = unsafe { libc::getpwent() };
            if entry.is_null() {
                if unsafe { *crate::unix_kernel::errno_address() } != 0 {
                    return Err(refused());
                }
                break;
            }
            count += 1;
            if count > 4096 {
                return Err(refused());
            }
            let home = unsafe { CStr::from_ptr((*entry).pw_dir) }
                .to_str()
                .map_err(|_| refused())?;
            let home = PathBuf::from(home);
            if !home.is_absolute() {
                return Err(refused());
            }
            check_home(&home, unsafe { (*entry).pw_uid })?;
        }
        Ok(())
    })();
    unsafe {
        libc::endpwent();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    /// A creation waits while another one holds the lock and takes it once
    /// that one is done; a holder that outlasts the limit still refuses it.
    #[test]
    fn a_waiting_creation_takes_the_lock_once_its_holder_is_done() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("barrier.lock");
        fs::write(&path, b"").unwrap();
        let holder = File::open(&path).unwrap();
        lock_within(&holder, Duration::ZERO, "BUSY").unwrap();
        let waiting = File::open(&path).unwrap();
        assert_eq!(lock_within(&waiting, Duration::from_millis(50), "BUSY").unwrap_err().code, "BUSY");
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            drop(holder);
        });
        let started = Instant::now();
        lock_within(&waiting, Duration::from_secs(5), "BUSY").unwrap();
        assert!(started.elapsed() >= Duration::from_millis(100));
        release.join().unwrap();
    }

    #[test]
    fn native_machine_lock_serializes_processes_and_kernel_exit_recovers_same_inode() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fixed-lock");
        fs::write(&path, VERSION).unwrap();
        let inode = fs::metadata(&path).unwrap().ino();
        let name = CString::new(path.as_os_str().as_bytes()).unwrap();
        let ready = crate::unix_kernel::cloexec_pipe().unwrap();
        let gate = crate::unix_kernel::cloexec_pipe().unwrap();
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            unsafe {
                libc::close(ready[0]);
                libc::close(gate[1]);
                let file = libc::open(name.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW);
                if file < 0 || libc::flock(file, libc::LOCK_EX | libc::LOCK_NB) != 0 {
                    libc::_exit(125);
                }
                let byte = 1_u8;
                if libc::write(ready[1], (&byte as *const u8).cast(), 1) != 1 {
                    libc::_exit(125);
                }
                let mut byte = 0_u8;
                libc::read(gate[0], (&mut byte as *mut u8).cast(), 1);
                libc::_exit(0); // Kernel closes the lock description, no manual unlink.
            }
        }
        unsafe {
            libc::close(ready[1]);
            libc::close(gate[0]);
        }
        let mut byte = 0_u8;
        assert_eq!(
            unsafe { libc::read(ready[0], (&mut byte as *mut u8).cast(), 1) },
            1
        );
        assert!(MachineBarrier::lock(File::open(&path).unwrap()).is_err());
        unsafe {
            libc::close(gate[1]);
            libc::close(ready[0]);
        }
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 0);
        let recovered = MachineBarrier::lock(File::open(&path).unwrap()).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
        drop(recovered);
    }
}
