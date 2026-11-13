//! Bounded destination read witnesses. The resource owner must already hold the
//! complete directory namespace; a caller path never supplies source authority.
use crate::{
    custody::REJECTED,
    execution_resource::Object,
    execution_resource_handles::{file_identity, HeldObject},
    readonly_sqlite::Connection,
};
use std::{
    fs::File,
    os::windows::{
        ffi::OsStrExt,
        fs::FileExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Path, PathBuf},
};
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_FILE_NOT_FOUND, HANDLE, INVALID_HANDLE_VALUE, WAIT_TIMEOUT},
    Storage::FileSystem::{
        CreateFileW, FindCloseChangeNotification, FindFirstChangeNotificationW, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_NOTIFY_CHANGE_ATTRIBUTES, FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_SECURITY, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    },
    System::Threading::WaitForSingleObject,
};

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
struct Watch(HANDLE);
impl Drop for Watch {
    fn drop(&mut self) {
        unsafe {
            FindCloseChangeNotification(self.0);
        }
    }
}
impl Watch {
    fn open(path: &Path) -> Result<Self, String> {
        let raw = unsafe {
            FindFirstChangeNotificationW(
                wide(path).as_ptr(),
                0,
                FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_ATTRIBUTES | FILE_NOTIFY_CHANGE_SECURITY,
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            return Err(REJECTED.into());
        }
        Ok(Self(raw))
    }
    fn recheck(&self) -> Result<(), String> {
        if unsafe { WaitForSingleObject(self.0, 0) } != WAIT_TIMEOUT {
            return Err(REJECTED.into());
        }
        Ok(())
    }
}
fn sidecar(path: &Path, owner: &str) -> Result<Option<HeldObject>, String> {
    let raw = unsafe {
        CreateFileW(
            wide(path).as_ptr(),
            0x8002_0080,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return if unsafe { GetLastError() } == ERROR_FILE_NOT_FOUND {
            Ok(None)
        } else {
            Err(REJECTED.into())
        };
    }
    let file = unsafe { File::from_raw_handle(raw) };
    let held = HeldObject {
        description: Object {
            handle: 0,
            identity: file_identity(file.as_raw_handle())?,
            kind: "sidecar".into(),
            private: true,
        },
        file,
    };
    if held.single_file_path(owner)? != path {
        return Err(REJECTED.into());
    }
    Ok(Some(held))
}
fn mode(main: &HeldObject) -> Result<u8, String> {
    let mut header = [0u8; 100];
    let mut offset = 0;
    while offset < header.len() {
        let count = main
            .file
            .seek_read(&mut header[offset..], offset as u64)
            .map_err(|_| REJECTED)?;
        if count == 0 {
            return Err(REJECTED.into());
        }
        offset += count;
    }
    if &header[..16] != b"SQLite format 3\0" || ![1, 2].contains(&header[18]) || header[18] != header[19] {
        return Err(REJECTED.into());
    }
    Ok(header[18])
}
pub struct FileSnapshot<'a> {
    main: &'a HeldObject,
    path: PathBuf,
    owner: String,
    mode: u8,
    wal: Option<HeldObject>,
    shm: Option<HeldObject>,
    watch: Watch,
}
impl<'a> FileSnapshot<'a> {
    pub fn open(main: &'a HeldObject, owner: &str) -> Result<Self, String> {
        let path = main.single_file_path(owner)?;
        let watch = Watch::open(path.parent().ok_or(REJECTED)?)?;
        // Do not let a read-only WAL connection create missing sidecars. A
        // mode/file-set mismatch refuses before SQLite opens, without fallback.
        let mode = mode(main)?;
        let wal = sidecar(&PathBuf::from(format!("{}-wal", path.to_str().ok_or(REJECTED)?)), owner)?;
        let shm = sidecar(&PathBuf::from(format!("{}-shm", path.to_str().ok_or(REJECTED)?)), owner)?;
        if wal.is_some() != (mode == 2) || shm.is_some() != wal.is_some() {
            return Err(REJECTED.into());
        }
        let result = Self {
            main,
            path,
            owner: owner.into(),
            mode,
            wal,
            shm,
            watch,
        };
        result.recheck()?;
        Ok(result)
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn wal_identity(&self) -> Option<&str> {
        self.wal.as_ref().map(|file| file.description.identity.as_str())
    }
    pub fn recheck(&self) -> Result<(), String> {
        self.watch.recheck()?;
        if self.main.single_file_path(&self.owner)? != self.path || mode(self.main)? != self.mode {
            return Err(REJECTED.into());
        }
        for file in [self.wal.as_ref(), self.shm.as_ref()].into_iter().flatten() {
            file.single_file_path(&self.owner)?;
        }
        self.watch.recheck()
    }
    /// Verify actual SQLite VFS main/WAL handles after its first snapshot read.
    /// The pinned SHM name and owner policy match the existing source reader.
    pub fn verify(&self, connection: &Connection) -> Result<(), String> {
        self.recheck()?;
        connection.verify_files(&self.main.description.identity, self.wal_identity(), &self.owner)?;
        self.recheck()
    }
}
