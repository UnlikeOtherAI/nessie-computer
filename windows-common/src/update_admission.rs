//! One persistent kernel lock shared by runtime creation and package replacement.
//! SYSTEM is the only writer. Interrupted maintenance remains a durable fence.
use crate::{custody::REJECTED, process::Process, release::pin_protected};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
};

pub fn known_folder(id: &windows_sys::core::GUID) -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{System::Com::CoTaskMemFree, UI::Shell::SHGetKnownFolderPath};
    let mut value = std::ptr::null_mut();
    if unsafe { SHGetKnownFolderPath(id, 0, std::ptr::null_mut(), &mut value) } != 0
        || value.is_null()
    {
        return Err(REJECTED.into());
    }
    let path = unsafe {
        let mut length = 0;
        while length < 32_768 && *value.add(length) != 0 {
            length += 1;
        }
        let result: Result<PathBuf, String> = if length == 32_768 {
            Err(REJECTED.into())
        } else {
            Ok(PathBuf::from(std::ffi::OsString::from_wide(
                std::slice::from_raw_parts(value, length),
            )))
        };
        CoTaskMemFree(value.cast());
        result
    }?;
    if !path.is_absolute() {
        return Err(REJECTED.into());
    }
    Ok(path)
}

pub fn root() -> Result<PathBuf, String> {
    Ok(
        known_folder(&windows_sys::Win32::UI::Shell::FOLDERID_ProgramData)?
            .join("Nessie Executor Updates"),
    )
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Maintenance {
    pub format: u32,
    #[serde(default)]
    pub draining: bool,
    #[serde(default)]
    pub restart_ready: bool,
    /// None admits normally; empty fences every generation; a digest admits
    /// only the installed replacement so it can establish fresh health.
    pub target: Option<String>,
}

fn validate_locked_marker(file: &mut File) -> Result<(), String> {
    let mut bytes = Vec::new();
    file.take(128)
        .read_to_end(&mut bytes)
        .map_err(|_| REJECTED)?;
    if bytes == b"nessie-update-admission-v1\n" {
        Ok(())
    } else {
        Err(REJECTED.into())
    }
}

pub struct Admission {
    file: File,
    root: PathBuf,
    _root: File,
    _pin: File,
    maintenance: Maintenance,
}

fn system() -> Result<(), String> {
    let current = Process::open(std::process::id())?;
    if current.sid != "S-1-5-18" || current.session != 0 {
        return Err(REJECTED.into());
    }
    Ok(())
}

impl Admission {
    pub fn acquire(writable: bool) -> Result<Self, String> {
        if writable {
            system()?;
        }
        let root = root()?;
        let root_pin = pin_protected(&root, true)?;
        let path = root.join("admission.lock");
        let pin = pin_protected(&path, false)?;
        let mut file = OpenOptions::new()
            .read(true)
            .open(&path)
            .map_err(|_| REJECTED)?;
        file.try_lock_exclusive().map_err(|_| REJECTED)?;
        validate_locked_marker(&mut file)?;
        let state_path = root.join("maintenance.json");
        let mut bytes = Vec::new();
        let _state_pin = pin_protected(&state_path, false)?;
        File::open(state_path)
            .map_err(|_| REJECTED)?
            .take(257)
            .read_to_end(&mut bytes)
            .map_err(|_| REJECTED)?;
        if bytes.len() > 256 {
            return Err(REJECTED.into());
        }
        let maintenance: Maintenance = serde_json::from_slice(&bytes).map_err(|_| REJECTED)?;
        if maintenance.format != 1
            || maintenance
                .target
                .as_ref()
                .is_some_and(|target| !target.is_empty() && !crate::custody::valid_nonce(target))
        {
            return Err(REJECTED.into());
        }
        Ok(Self {
            file,
            root,
            _root: root_pin,
            _pin: pin,
            maintenance,
        })
    }

    pub fn admit(&self, digest: &str) -> Result<(), String> {
        if self
            .maintenance
            .target
            .as_ref()
            .is_some_and(|target| target != digest)
        {
            return Err("Nessie Computer is waiting to finish its update.".into());
        }
        Ok(())
    }

    pub fn admit_daemon(&self, digest: &str) -> Result<(), String> {
        self.admit(digest)?;
        if self.maintenance.draining && !self.maintenance.restart_ready {
            return Err("Nessie Computer is waiting to finish its update.".into());
        }
        Ok(())
    }

    pub fn set_draining(&mut self, draining: bool, restart_ready: bool) -> Result<(), String> {
        if self.maintenance.draining == draining && self.maintenance.restart_ready == restart_ready
        {
            return Ok(());
        }
        self.write(Maintenance {
            format: 1,
            target: self.maintenance.target.clone(),
            draining,
            restart_ready,
        })
    }

    pub fn set_target(&mut self, target: Option<String>) -> Result<(), String> {
        system()?;
        if target
            .as_ref()
            .is_some_and(|value| !value.is_empty() && !crate::custody::valid_nonce(value))
        {
            return Err(REJECTED.into());
        }
        let next = Maintenance {
            format: 1,
            target,
            draining: self.maintenance.draining,
            restart_ready: self.maintenance.restart_ready,
        };
        self.write(next)
    }

    fn write(&mut self, next: Maintenance) -> Result<(), String> {
        system()?;
        let bytes = serde_json::to_vec(&next).map_err(|_| REJECTED)?;
        let draft = self.root.join("maintenance.draft");
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&draft)
            .map_err(|_| REJECTED)?;
        file.write_all(&bytes).map_err(|_| REJECTED)?;
        file.sync_all().map_err(|_| REJECTED)?;
        drop(file);
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let source: Vec<u16> = draft.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = self
            .root
            .join("maintenance.json")
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(REJECTED.into());
        }
        self.maintenance = next;
        Ok(())
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_admission_marker_is_read_through_its_locked_handle() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("admission.lock");
        std::fs::write(&path, b"nessie-update-admission-v1\n").unwrap();
        let mut held = OpenOptions::new().read(true).open(&path).unwrap();
        held.try_lock_exclusive().unwrap();
        // Windows enforces byte-range locks even for another handle in this process.
        assert_eq!(std::fs::read(&path).unwrap_err().raw_os_error(), Some(33));
        validate_locked_marker(&mut held).unwrap();
        drop(held);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"nessie-update-admission-v1\n"
        );
    }
}
