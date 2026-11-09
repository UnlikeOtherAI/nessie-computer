use crate::protocol::NativeError;
use std::{fs::File, os::windows::{ffi::OsStrExt, io::{AsRawHandle, FromRawHandle}}, path::{Component, Path, PathBuf}};
use windows_sys::Win32::{Foundation::{HANDLE, INVALID_HANDLE_VALUE}, Storage::FileSystem::{
    CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, FILE_READ_ATTRIBUTES, FILE_LIST_DIRECTORY,
    FindFirstChangeNotificationW, FindCloseChangeNotification, GetFileInformationByHandleEx,
    FileIdInfo, FILE_ID_INFO, GetDriveTypeW, GetFinalPathNameByHandleW,
    FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_SECURITY,
    FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_ATTRIBUTES,
}, System::Threading::WaitForSingleObject};

pub fn fail() -> NativeError { NativeError::new("t3_source_resource_changed_or_unavailable") }
pub fn wide(path: &Path) -> Vec<u16> { path.as_os_str().encode_wide().chain(Some(0)).collect() }

pub fn file_identity(handle: HANDLE) -> Result<String, NativeError> {
    let mut id: FILE_ID_INFO = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandleEx(handle, FileIdInfo, (&mut id as *mut FILE_ID_INFO).cast(),
        std::mem::size_of::<FILE_ID_INFO>() as u32) } == 0 { return Err(fail()); }
    Ok(format!("{:016x}:{}", id.VolumeSerialNumber,
        id.FileId.Identifier.iter().map(|byte| format!("{byte:02x}")).collect::<String>()))
}

pub struct Held { pub file: File, pub identity: String, directory: bool }
impl Held {
    /// VOLUME_NAME_GUID avoids a drive-letter/SUBST remap between the kernel
    /// proof and SQLite's open. All subsequent opens use this held namespace.
    pub fn path(&self) -> Result<PathBuf, NativeError> {
        let mut buffer = vec![0_u16; 32768];
        let length = unsafe { GetFinalPathNameByHandleW(self.file.as_raw_handle(), buffer.as_mut_ptr(),
            buffer.len() as u32, 1) } as usize;
        if length == 0 || length >= buffer.len() { return Err(fail()); }
        let path = String::from_utf16(&buffer[..length]).map_err(|_| fail())?;
        if !path.starts_with(r"\\?\Volume{") { return Err(fail()); }
        Ok(PathBuf::from(path))
    }
    pub fn open(path: &Path, directory: bool, writable: bool, private: bool) -> Result<Self, NativeError> {
        // Metadata-only directory opens bypass share-access accounting. Request
        // LIST_DIRECTORY (READ_DATA for directories) so the omitted WRITE/DELETE
        // sharing pins every name component, including registration/home roots.
        // No listing is performed; files retain their existing read/WAL policy.
        let handle = unsafe { CreateFileW(wide(path).as_ptr(),
            FILE_READ_ATTRIBUTES | 0x0002_0000 | if directory { FILE_LIST_DIRECTORY } else { 0x8000_0000 },
            FILE_SHARE_READ | if writable { FILE_SHARE_WRITE } else { 0 },
            std::ptr::null(), OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut()) };
        if handle == INVALID_HANDLE_VALUE { return Err(fail()); }
        let file = unsafe { File::from_raw_handle(handle) };
        Self::from_file(file, directory, private)
    }
    pub(super) fn from_file(file: File, directory: bool, private: bool) -> Result<Self, NativeError> {
        let handle = file.as_raw_handle();
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0
            || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory {
            return Err(fail());
        }
        if private { crate::state_security::verify_owner_only_handle(handle)?; }
        Ok(Self { identity: file_identity(handle)?, file, directory })
    }
    pub fn recheck_object(&self) -> Result<(), NativeError> {
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(self.file.as_raw_handle(), &mut info) } == 0
            || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != self.directory { return Err(fail()); }
        Ok(())
    }
    pub fn recheck(&self) -> Result<(), NativeError> {
        self.recheck_object()?;
        crate::state_security::verify_owner_only_handle(self.file.as_raw_handle())
    }
}

/// Pin every name component before opening SQLite. No directory or file handle
/// permits DELETE sharing. Renaming a parent or substituting a junction cannot
/// change the path SQLite subsequently opens while these handles remain live.
pub fn chain(path: &Path) -> Result<Vec<Held>, NativeError> {
    let held = namespace_chain(path)?;
    held.last().ok_or_else(fail)?.recheck()?;
    Ok(held)
}
/// Namespace stability only. Callers must separately prove their ACL policy.
pub fn namespace_chain(path: &Path) -> Result<Vec<Held>, NativeError> {
    let raw = path.to_str().ok_or_else(fail)?;
    let bytes = raw.as_bytes();
    if bytes.len() < 4 || !bytes[0].is_ascii_alphabetic() || &bytes[1..3] != b":\\"
        || raw.len() > 1024 || raw.contains('/') || raw.contains('\0') { return Err(fail()); }
    if raw[3..].split('\\').any(|s| s.is_empty() || s == "." || s == ".."
        || s.ends_with(['.', ' ']) || s.contains(':')) { return Err(fail()); }
    if unsafe { GetDriveTypeW(wide(Path::new(&raw[..3])).as_ptr()) } != 3 { return Err(fail()); }
    let mut current = PathBuf::new();
    let mut held = Vec::new();
    for component in path.components() {
        if matches!(component, Component::CurDir | Component::ParentDir) { return Err(fail()); }
        current.push(component);
        if matches!(component, Component::Prefix(_)) { continue; }
        // A write-capable directory handle could set a reparse point without
        // renaming it. Exclude write sharing as well as delete sharing for the
        // complete chain, including handles acquired before this admission.
        held.push(Held::open(&current, true, false, false)?);
        current = held.last().ok_or_else(fail)?.path()?;
    }
    Ok(held)
}

pub struct Watch(HANDLE);
impl Watch {
    pub(super) fn raw(&self) -> u64 { self.0 as usize as u64 }
    pub fn new(path: &Path, writes: bool) -> Result<Self, NativeError> {
        Self::flags(path, FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_SECURITY
                | FILE_NOTIFY_CHANGE_ATTRIBUTES
                | if writes { FILE_NOTIFY_CHANGE_LAST_WRITE } else { 0 })
    }
    pub fn security(path: &Path) -> Result<Self, NativeError> { Self::flags(path, FILE_NOTIFY_CHANGE_SECURITY) }
    pub fn metadata(path: &Path) -> Result<Self, NativeError> {
        Self::flags(path, FILE_NOTIFY_CHANGE_SECURITY | FILE_NOTIFY_CHANGE_ATTRIBUTES)
    }
    fn flags(path: &Path, flags: u32) -> Result<Self, NativeError> {
        let handle = unsafe { FindFirstChangeNotificationW(wide(path).as_ptr(), 0,
            flags) };
        if handle == INVALID_HANDLE_VALUE { return Err(fail()); }
        Ok(Self(handle))
    }
    /// A signalled notification is never reset: even change-and-restore fails.
    pub fn recheck(&self) -> Result<(), NativeError> {
        if unsafe { WaitForSingleObject(self.0, 0) } != 258 { return Err(fail()); }
        Ok(())
    }
}
impl Drop for Watch { fn drop(&mut self) { unsafe { FindCloseChangeNotification(self.0); } } }

