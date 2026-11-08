//! Metadata-only candidate namespace pins. The service's resource owner supplies
//! identity/authority separately; opening a path here never issues admission.
use super::HeldObject;
use crate::custody::REJECTED;
use std::{fs::File, os::windows::{ffi::OsStrExt, io::FromRawHandle}, path::{Path, PathBuf}};
use windows_sys::Win32::{Foundation::{HANDLE, INVALID_HANDLE_VALUE, WAIT_TIMEOUT},
    Storage::FileSystem::{CreateFileW, FILE_READ_ATTRIBUTES, READ_CONTROL, FILE_SHARE_READ, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, GetDriveTypeW,
        FindFirstChangeNotificationW, FindCloseChangeNotification, FILE_NOTIFY_CHANGE_SECURITY},
    System::Threading::WaitForSingleObject};

fn wide(path: &Path) -> Vec<u16> { path.as_os_str().encode_wide().chain(Some(0)).collect() }
struct Watch(HANDLE);
unsafe impl Send for Watch {}
impl Watch {
    fn open(path: &Path) -> Result<Self, String> {
        let handle = unsafe { FindFirstChangeNotificationW(wide(path).as_ptr(), 0, FILE_NOTIFY_CHANGE_SECURITY) };
        if handle == INVALID_HANDLE_VALUE { return Err(REJECTED.into()); }
        Ok(Self(handle))
    }
    fn recheck(&self) -> Result<(), String> {
        if unsafe { WaitForSingleObject(self.0, 0) } != WAIT_TIMEOUT { return Err(REJECTED.into()); }
        Ok(())
    }
}
impl Drop for Watch { fn drop(&mut self) { unsafe { FindCloseChangeNotification(self.0); } } }

pub struct HeldCandidateDirectory { objects: Vec<HeldObject>, watches: Vec<Watch>, owner: String }
impl HeldCandidateDirectory {
    /// Caller must hold its actual-owner impersonation guard through this call.
    /// No source or provider child files are opened, only the directory chain.
    pub fn open(path: &Path, owner: &str) -> Result<Self, String> {
        let (root, parts) = components(path)?;
        if unsafe { GetDriveTypeW(wide(&root).as_ptr()) } != 3 { return Err(REJECTED.into()); }
        let mut result = Self { objects: Vec::new(), watches: Vec::new(), owner: owner.into() };
        let mut current = root;
        for index in 0..=parts.len() {
            if index > 0 { current.push(&parts[index - 1]); }
            let handle = unsafe { CreateFileW(wide(&current).as_ptr(), FILE_READ_ATTRIBUTES | READ_CONTROL,
                FILE_SHARE_READ, std::ptr::null(), OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                std::ptr::null_mut()) };
            if handle == INVALID_HANDLE_VALUE { return Err(REJECTED.into()); }
            let object = HeldObject::directory(unsafe { File::from_raw_handle(handle) }, index == parts.len(), owner)?;
            current = object.directory_path(owner)?;
            // Never reset: an ACL change-and-restore still invalidates the guard.
            result.watches.push(Watch::open(&current)?);
            result.objects.push(object);
        }
        result.recheck()?;
        Ok(result)
    }
    pub fn identity(&self) -> &str { &self.objects.last().expect("nonempty held directory chain").description.identity }
    pub fn canonical_path(&self) -> Result<PathBuf, String> {
        self.recheck()?;
        self.objects.last().ok_or(REJECTED)?.directory_path(&self.owner)
    }
    pub fn recheck(&self) -> Result<(), String> {
        for watch in &self.watches { watch.recheck()?; }
        for object in &self.objects { object.recheck(&self.owner)?; }
        for watch in &self.watches { watch.recheck()?; }
        Ok(())
    }
}
fn components(path: &Path) -> Result<(PathBuf, Vec<String>), String> {
    let raw = path.to_str().ok_or(REJECTED)?;
    if raw.len() > 32760 || raw.contains(['/', '\0']) { return Err(REJECTED.into()); }
    let end = if raw.as_bytes().get(0).is_some_and(u8::is_ascii_alphabetic) && raw.as_bytes().get(1..3) == Some(b":\\") {
        3
    } else if let Some(tail) = raw.strip_prefix(r"\\?\Volume{") {
        let guid = tail.get(..36).ok_or(REJECTED)?;
        if tail.get(36..38) != Some("}\\") || !guid.bytes().enumerate().all(|(i,b)|
            if [8,13,18,23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() }) { return Err(REJECTED.into()); }
        raw.len() - tail.len() + 38
    } else { return Err(REJECTED.into()); };
    let remainder = &raw[end..];
    if remainder.is_empty() { return Err(REJECTED.into()); } // A provider home cannot be the volume root.
    let parts = remainder.split('\\').map(str::to_owned).collect::<Vec<_>>();
    if parts.iter().any(|p| p.is_empty() || p == "." || p == ".." || p.ends_with(['.', ' '])
        || p.contains([':', '*', '?']) || p.chars().any(char::is_control)) { return Err(REJECTED.into()); }
    Ok((PathBuf::from(&raw[..end]), parts))
}
