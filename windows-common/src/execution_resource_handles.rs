//! Duplicate the authenticated native peer's real handles; never reopen a path.
use crate::{custody::REJECTED, execution_resource::{Object, SETTINGS_LIMIT}, process::{Owned, Process}};
use std::{fs::File, os::windows::{fs::FileExt, io::{AsRawHandle, FromRawHandle}}};
use windows_sys::Win32::{
    Foundation::{DuplicateHandle, LocalFree, DUPLICATE_SAME_ACCESS, HANDLE, WAIT_TIMEOUT},
    Security::{Authorization::{ConvertStringSidToSidW, GetSecurityInfo, SE_FILE_OBJECT},
        GetAce, EqualSid, IsValidSid, ACCESS_ALLOWED_ACE, ACL, PSID,
        OWNER_SECURITY_INFORMATION, DACL_SECURITY_INFORMATION},
    Storage::FileSystem::{GetFileType, FILE_TYPE_DISK, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        GetFileInformationByHandleEx, FileIdInfo, FILE_ID_INFO, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT},
    System::Threading::{OpenProcess, GetCurrentProcess, WaitForSingleObject, PROCESS_DUP_HANDLE},
};

pub struct Duplicator { process: Owned }
impl Duplicator {
    pub fn new(caller: &Process) -> Result<Self, String> {
        if !caller.alive() { return Err(REJECTED.into()); }
        let process = Owned(unsafe { OpenProcess(PROCESS_DUP_HANDLE, 0, caller.generation.pid) });
        if process.0.is_null() { return Err(REJECTED.into()); }
        // The held caller handle and the fresh generation observation together
        // rule out PID reuse between authentication and handle duplication.
        if Process::open(caller.generation.pid)?.generation != caller.generation || !caller.alive() {
            return Err(REJECTED.into());
        }
        Ok(Self { process })
    }
    pub fn duplicate(&self, raw: u64) -> Result<Owned, String> {
        let raw = usize::try_from(raw).map_err(|_| REJECTED)?;
        if raw == 0 { return Err(REJECTED.into()); }
        let mut duplicate = std::ptr::null_mut();
        if unsafe { DuplicateHandle(self.process.0, raw as HANDLE, GetCurrentProcess(), &mut duplicate,
            0, 0, DUPLICATE_SAME_ACCESS) } == 0 { return Err(REJECTED.into()); }
        Ok(Owned(duplicate))
    }
    pub fn file(&self, object: &Object, owner: &str) -> Result<HeldObject, String> {
        let handle = self.duplicate(object.handle)?;
        if unsafe { GetFileType(handle.0) } != FILE_TYPE_DISK { return Err(REJECTED.into()); }
        let file = unsafe { File::from_raw_handle(handle.0) };
        std::mem::forget(handle);
        let held = HeldObject { file, description: object.clone() };
        held.recheck(owner)?;
        Ok(held)
    }
}
pub struct HeldObject { pub file: File, pub description: Object }
impl HeldObject {
    pub fn recheck(&self, owner: &str) -> Result<(), String> {
        let handle = self.file.as_raw_handle();
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        let mut id: FILE_ID_INFO = unsafe { std::mem::zeroed() };
        let directory = ["directory", "source-root", "provider-home"].contains(&self.description.kind.as_str());
        if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0
            || unsafe { GetFileInformationByHandleEx(handle, FileIdInfo, (&mut id as *mut FILE_ID_INFO).cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32) } == 0
            || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory {
            return Err(REJECTED.into());
        }
        let identity = format!("{:016x}:{}", id.VolumeSerialNumber,
            id.FileId.Identifier.iter().map(|b| format!("{b:02x}")).collect::<String>());
        if identity != self.description.identity { return Err(REJECTED.into()); }
        if self.description.private { owner_only(handle, owner)?; }
        Ok(())
    }
    pub fn bytes(&self, limit: usize) -> Result<Vec<u8>, String> {
        if limit > SETTINGS_LIMIT { return Err(REJECTED.into()); }
        let mut bytes = vec![0; limit + 1];
        let mut offset = 0;
        while offset < bytes.len() {
            let read = self.file.seek_read(&mut bytes[offset..], offset as u64).map_err(|_| REJECTED)?;
            if read == 0 { break; }
            offset += read;
        }
        if offset > limit { return Err(REJECTED.into()); }
        bytes.truncate(offset);
        Ok(bytes)
    }
}
pub fn check_watches(watches: &[Owned]) -> Result<(), String> {
    if watches.iter().any(|w| unsafe { WaitForSingleObject(w.0, 0) } != WAIT_TIMEOUT) {
        return Err(REJECTED.into());
    }
    Ok(())
}
struct Sid(PSID);
impl Sid {
    fn new(s: &str) -> Result<Self, String> {
        if !crate::is_sid_string(s) { return Err(REJECTED.into()); }
        let wide: Vec<u16> = s.encode_utf16().chain(Some(0)).collect();
        let mut sid = std::ptr::null_mut();
        if unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) } == 0 { return Err(REJECTED.into()); }
        Ok(Self(sid))
    }
}
impl Drop for Sid { fn drop(&mut self) { unsafe { LocalFree(self.0); } } }
fn owner_only(handle: HANDLE, owner_sid: &str) -> Result<(), String> {
    let user = Sid::new(owner_sid)?;
    let system = Sid::new("S-1-5-18")?;
    let mut owner = std::ptr::null_mut();
    let mut acl: *mut ACL = std::ptr::null_mut();
    let mut descriptor = std::ptr::null_mut();
    if unsafe { GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &mut owner, std::ptr::null_mut(), &mut acl, std::ptr::null_mut(), &mut descriptor) } != 0 {
        return Err(REJECTED.into());
    }
    let valid = (|| {
        if owner.is_null() || acl.is_null() || unsafe { EqualSid(owner, user.0) } == 0 { return false; }
        let count = unsafe { (*acl).AceCount };
        if count == 0 { return false; }
        for i in 0..count {
            let mut ace = std::ptr::null_mut();
            if unsafe { GetAce(acl, i as u32, &mut ace) } == 0 || ace.is_null() { return false; }
            let entry = ace.cast::<ACCESS_ALLOWED_ACE>();
            if unsafe { (*entry).Header.AceType } != 0 { return false; }
            let sid = unsafe { std::ptr::addr_of!((*entry).SidStart) } as PSID;
            if unsafe { IsValidSid(sid) } == 0 || (unsafe { EqualSid(sid, user.0) } == 0
                && unsafe { EqualSid(sid, system.0) } == 0) { return false; }
        }
        true
    })();
    unsafe { LocalFree(descriptor); }
    if valid { Ok(()) } else { Err(REJECTED.into()) }
}
