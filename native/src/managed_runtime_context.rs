//! One kernel lock for every supported launch under the real local UID.
use crate::{managed_machine_barrier::MachineBarrier, protocol::NativeError};
use std::ffi::CStr;
use std::fs::{self, File, OpenOptions};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
pub use crate::kernel_context::{birth, boot_id, valid_boot_id};

pub fn refused() -> NativeError {
    NativeError::new("EXECUTOR_MANAGED_CONTEXT_REJECTED")
}

pub fn home() -> Result<PathBuf, NativeError> {
    let uid = unsafe { libc::getuid() };
    if uid != unsafe { libc::geteuid() } {
        return Err(refused());
    }
    let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut found = std::ptr::null_mut();
    if unsafe {
        libc::getpwuid_r(
            uid,
            entry.as_mut_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut found,
        )
    } != 0
        || found.is_null()
    {
        return Err(refused());
    }
    let profile = unsafe { CStr::from_ptr((*found).pw_dir) }
        .to_str()
        .map_err(|_| refused())?;
    let profile = PathBuf::from(profile);
    if !profile.is_absolute() || fs::canonicalize(&profile).map_err(|_| refused())? != profile {
        return Err(refused());
    }
    Ok(profile)
}

fn directory(path: &Path, private: bool) -> Result<(), NativeError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(path)
                .map_err(|_| refused())?;
            File::open(path.parent().ok_or_else(refused)?)
                .map_err(|_| refused())?
                .sync_all()
                .map_err(|_| refused())?;
        }
        Err(_) => return Err(refused()),
        Ok(_) => {}
    }
    let entry = fs::symlink_metadata(path).map_err(|_| refused())?;
    if !entry.is_dir()
        || entry.file_type().is_symlink()
        || entry.uid() != unsafe { libc::getuid() }
        || entry.mode() & (if private { 0o077 } else { 0o022 }) != 0
    {
        return Err(refused());
    }
    Ok(())
}

pub fn root() -> Result<PathBuf, NativeError> {
    if unsafe { libc::getuid() } == 0 {
        let path = PathBuf::from(crate::managed_machine_barrier::ROOT_RUNTIME);
        directory(&path, false)?;
        directory(&path.join("managed-runtimes"), false)?;
        return Ok(path);
    }
    let home = home()?;
    directory(&home, false)?;
    let general = home.join(".nessie");
    directory(&general, false)?;
    let root = general.join("personal-inference");
    directory(&root, true)?;
    directory(&root.join("managed-runtimes"), true)?;
    Ok(root)
}

/// Local-only execution can remain available in a container. It does not
/// establish an independent personal credential context.
pub fn require_custody_context() -> Result<(), NativeError> {
    #[cfg(target_os = "macos")]
    {
        crate::personal_state_context::protected_root()?;
        crate::macos_provenance::require_current_release()?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
    let kernel = fs::read_to_string("/proc/sys/kernel/osrelease").map_err(|_| refused())?;
    if unsafe { libc::getuid() } == 0
        || kernel.to_ascii_lowercase().contains("microsoft")
        || Path::new("/.dockerenv").exists()
        || Path::new("/run/.containerenv").exists()
        || std::env::var_os("container").is_some()
    {
        return Err(refused());
    }
    Ok(())
    }
}

pub struct Barrier {
    _file: File,
    _machine: MachineBarrier,
    pub root: PathBuf,
}

/// How long a creation waits for another one to leave the barrier. Inventory
/// holds it longest, probing each live runtime for at most 250 milliseconds.
const CREATION_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

impl Barrier {
    pub fn acquire() -> Result<Self, NativeError> {
        let machine = MachineBarrier::wait(CREATION_WAIT)?;
        if unsafe { libc::getuid() } == 0 {
            crate::managed_machine_barrier::refuse_protected_users()?;
        }
        let root = root()?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root.join("managed-launch.lock"))
            .map_err(|_| refused())?;
        let entry = file.metadata().map_err(|_| refused())?;
        if !entry.is_file()
            || entry.uid() != unsafe { libc::getuid() }
            || entry.mode() & 0o077 != 0
            || entry.nlink() != 1
        {
            return Err(refused());
        }
        crate::managed_machine_barrier::lock_within(&file, CREATION_WAIT, "EXECUTOR_MANAGED_ADMISSION_BUSY")?;
        Ok(Self {
            _file: file,
            _machine: machine,
            root,
        })
    }

    pub fn check_protection(&self) -> Result<(), NativeError> {
        crate::managed_transition::refuse_unresolved(&self.root)?;
        let path = self.root.join("guard.json");
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if self.root.join("profiles").exists() {
                    return Err(refused());
                }
                return Ok(());
            }
            Err(_) => return Err(refused()),
        };
        let entry = file.metadata().map_err(|_| refused())?;
        if !entry.is_file()
            || entry.nlink() != 1
            || entry.uid() != unsafe { libc::getuid() }
            || entry.mode() & 0o077 != 0
            || entry.len() > 1024 * 1024
        {
            return Err(refused());
        }
        let state: serde_json::Value = serde_json::from_reader(file).map_err(|_| refused())?;
        if state["version"] != 1
            || !state["registrations"].is_array()
            || state["protection"] != serde_json::Value::Null
                && (!state["protection"]["profiles"].is_array()
                    || state["protection"]["profiles"]
                        .as_array()
                        .unwrap()
                        .is_empty())
        {
            return Err(refused());
        }
        // This command can create only the verified v2 Nessie entry. Every
        // arbitrary host-operation consumer in that entry checks the fence.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kernel_birth_and_owner_profile_do_not_use_home_environment() {
        assert!(!birth(unsafe { libc::getpid() }).unwrap().is_empty());
        assert!(birth(i32::MAX).is_err());
        if unsafe { libc::getuid() } != 0 {
            assert!(home().unwrap().is_absolute());
        }
    }
}
