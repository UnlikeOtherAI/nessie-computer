use super::{NativeError, IO_FAILURE, NOT_FOUND, REJECTED};
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_FILE_NOT_FOUND, ERROR_NOT_ALL_ASSIGNED, ERROR_PATH_NOT_FOUND,
    ERROR_SUCCESS, HANDLE, HLOCAL, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
    NO_MULTIPLE_TRUSTEE, SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER,
    TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    CopySid, CreateWellKnownSid, EqualSid, GetAce, GetLengthSid, GetSecurityDescriptorControl,
    AdjustTokenPrivileges, GetTokenInformation, IsValidSid, LookupAccountNameW, LookupPrivilegeValueW,
    LUID_AND_ATTRIBUTES, SID_NAME_USE, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TokenOwner,
    TokenUser, WinLocalSystemSid, ACCESS_ALLOWED_ACE, ACL,
    DACL_SECURITY_INFORMATION, INHERITED_ACE, OWNER_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_MAX_SID_SIZE,
    SE_DACL_PROTECTED, SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_OWNER, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// `ACCESS_ALLOWED_ACE_TYPE`. Every other ACE type has a different body, so
/// the reader refuses them rather than reading one at the wrong offset.
const ACCESS_ALLOWED: u8 = 0;

fn path_error(code: u32) -> NativeError {
    NativeError::new(if matches!(code, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
        NOT_FOUND
    } else {
        IO_FAILURE
    })
}

fn wide(path: &str) -> Vec<u16> {
    OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect()
}

/// A SID copied out of the buffer that produced it, so the buffer's life
/// stops mattering to every later comparison.
struct OwnedSid(Vec<u8>);

impl OwnedSid {
    fn pointer(&self) -> PSID {
        self.0.as_ptr() as PSID
    }
}

fn copy_sid(source: PSID) -> Result<OwnedSid, NativeError> {
    if source.is_null() || unsafe { IsValidSid(source) } == 0 {
        return Err(NativeError::new(REJECTED));
    }
    let length = unsafe { GetLengthSid(source) } as usize;
    let mut bytes = vec![0_u8; length];
    if unsafe { CopySid(length as u32, bytes.as_mut_ptr() as PSID, source) } == 0 {
        return Err(NativeError::new(IO_FAILURE));
    }
    Ok(OwnedSid(bytes))
}

/// The SID of the account this process runs as. Everything owner-only is
/// decided against this one value.
fn current_user_sid() -> Result<OwnedSid, NativeError> {
    let mut token: HANDLE = INVALID_HANDLE_VALUE;
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(NativeError::new(IO_FAILURE));
    }
    let mut needed = 0_u32;
    unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
    let mut buffer = vec![0_u8; needed.max(1) as usize];
    let read = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
            &mut needed,
        )
    };
    let sid = if read == 0 {
        Err(NativeError::new(IO_FAILURE))
    } else {
        copy_sid(unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid })
    };
    unsafe { CloseHandle(token) };
    sid
}

/// A machine attestation may run only in the installed service account or
/// SYSTEM's session zero. An elevated administrator is not a substitute.
pub fn verify_service_context() -> Result<(), NativeError> {
    let user = current_user_sid()?;
    let service = service_sid()?;
    let system = local_system_sid()?;
    if unsafe { EqualSid(user.pointer(), service.pointer()) } == 0
        && unsafe { EqualSid(user.pointer(), system.pointer()) } == 0 {
        return Err(NativeError::new(REJECTED));
    }
    let mut token: HANDLE = INVALID_HANDLE_VALUE;
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(NativeError::new(IO_FAILURE));
    }
    let mut session = u32::MAX;
    let mut needed = 0;
    let read = unsafe { GetTokenInformation(token, windows_sys::Win32::Security::TokenSessionId,
        (&mut session as *mut u32).cast(), std::mem::size_of::<u32>() as u32, &mut needed) };
    unsafe { CloseHandle(token) };
    if read == 0 || session != 0 { return Err(NativeError::new(REJECTED)); }
    Ok(())
}

/// The SID Windows stamps as owner on objects **this token creates**.
///
/// It is the token user for an ordinary account, and the Administrators
/// group for an elevated one, which is the whole reason this function
/// exists: a file the supervisor creates with an ordinary `open` is owned
/// by this SID, never by the token user as such. Reading it is what lets
/// the file check ask "did this account create this file?" instead of a
/// question Windows never promised to answer.
fn token_owner_sid() -> Result<OwnedSid, NativeError> {
    let mut token: HANDLE = INVALID_HANDLE_VALUE;
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(NativeError::new(IO_FAILURE));
    }
    let mut needed = 0_u32;
    unsafe { GetTokenInformation(token, TokenOwner, std::ptr::null_mut(), 0, &mut needed) };
    let mut buffer = vec![0_u8; needed.max(1) as usize];
    let read = unsafe {
        GetTokenInformation(
            token,
            TokenOwner,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
            &mut needed,
        )
    };
    let sid = if read == 0 {
        Err(NativeError::new(IO_FAILURE))
    } else {
        copy_sid(unsafe { (*buffer.as_ptr().cast::<TOKEN_OWNER>()).Owner })
    };
    unsafe { CloseHandle(token) };
    sid
}

fn local_system_sid() -> Result<OwnedSid, NativeError> {
    let mut bytes = vec![0_u8; SECURITY_MAX_SID_SIZE as usize];
    let mut size = SECURITY_MAX_SID_SIZE;
    let created = unsafe {
        CreateWellKnownSid(
            WinLocalSystemSid,
            std::ptr::null_mut(),
            bytes.as_mut_ptr() as PSID,
            &mut size,
        )
    };
    if created == 0 {
        return Err(NativeError::new(IO_FAILURE));
    }
    bytes.truncate(size as usize);
    Ok(OwnedSid(bytes))
}

fn service_sid() -> Result<OwnedSid, NativeError> {
    let account: Vec<u16> = OsStr::new(r"NT SERVICE\NessieExecutor")
        .encode_wide().chain(std::iter::once(0)).collect();
    let mut sid_bytes = 0_u32;
    let mut domain_chars = 0_u32;
    let mut use_type: SID_NAME_USE = 0;
    unsafe {
        LookupAccountNameW(
            std::ptr::null(), account.as_ptr(), std::ptr::null_mut(), &mut sid_bytes,
            std::ptr::null_mut(), &mut domain_chars, &mut use_type,
        );
    }
    if sid_bytes == 0 { return Err(NativeError::new(IO_FAILURE)); }
    let mut sid = vec![0_u8; sid_bytes as usize];
    let mut domain = vec![0_u16; domain_chars.max(1) as usize];
    if unsafe {
        LookupAccountNameW(
            std::ptr::null(), account.as_ptr(), sid.as_mut_ptr() as PSID, &mut sid_bytes,
            domain.as_mut_ptr(), &mut domain_chars, &mut use_type,
        )
    } == 0 {
        return Err(NativeError::new(IO_FAILURE));
    }
    sid.truncate(sid_bytes as usize);
    copy_sid(sid.as_mut_ptr() as PSID)
}

/// Windows Installer runs this helper as SYSTEM, but `SeRestorePrivilege`
/// is not guaranteed enabled in its token. Naming a different owner needs
/// that privilege; without it a fresh MSI can still leave SYSTEM as owner.
fn enable_restore_privilege() -> Result<(), NativeError> {
    let mut token: HANDLE = INVALID_HANDLE_VALUE;
    if unsafe {
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES, &mut token)
    } == 0 {
        return Err(NativeError::new(IO_FAILURE));
    }
    let name: Vec<u16> = OsStr::new("SeRestorePrivilege")
        .encode_wide().chain(std::iter::once(0)).collect();
    let mut luid = unsafe { std::mem::zeroed() };
    let found = unsafe { LookupPrivilegeValueW(std::ptr::null(), name.as_ptr(), &mut luid) } != 0;
    let privileges = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES { Luid: luid, Attributes: 2 }],
    };
    let adjusted = found && unsafe {
        AdjustTokenPrivileges(token, 0, &privileges, 0, std::ptr::null_mut(), std::ptr::null_mut())
    } != 0 && unsafe { GetLastError() } != ERROR_NOT_ALL_ASSIGNED;
    unsafe { CloseHandle(token) };
    if adjusted { Ok(()) } else { Err(NativeError::new(IO_FAILURE)) }
}

fn full_control(sid: PSID, trustee_type: i32) -> EXPLICIT_ACCESS_W {
    EXPLICIT_ACCESS_W {
        grfAccessPermissions: FILE_ALL_ACCESS,
        grfAccessMode: SET_ACCESS,
        grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: trustee_type,
            ptstrName: sid as *mut u16,
        },
    }
}

fn secure_directory_for_owner(
    path: &str, owner: OwnedSid, requires_restore_privilege: bool,
) -> Result<(), NativeError> {
    std::fs::create_dir_all(path).map_err(|_| NativeError::new(IO_FAILURE))?;
    if requires_restore_privilege { enable_restore_privilege()?; }
    let system = local_system_sid()?;
    let entries = [
        full_control(owner.pointer(), TRUSTEE_IS_USER),
        full_control(system.pointer(), TRUSTEE_IS_WELL_KNOWN_GROUP),
    ];
    let mut acl: *mut ACL = std::ptr::null_mut();
    if unsafe { SetEntriesInAclW(2, entries.as_ptr(), std::ptr::null(), &mut acl) }
        != ERROR_SUCCESS
    {
        return Err(NativeError::new(IO_FAILURE));
    }
    // PROTECTED severs inheritance, so a permissive ACE on any parent — a
    // roaming profile, an administrator's earlier grant — cannot reach the
    // state directory. Owner is re-stamped because only an owner can later
    // repair a DACL it does not appear in.
    let applied = unsafe {
        SetNamedSecurityInfoW(
            wide(path).as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION
                | DACL_SECURITY_INFORMATION
                | PROTECTED_DACL_SECURITY_INFORMATION,
            owner.pointer(),
            std::ptr::null_mut(),
            acl,
            std::ptr::null(),
        )
    };
    unsafe { LocalFree(acl as HLOCAL) };
    if applied != ERROR_SUCCESS {
        return Err(NativeError::new(IO_FAILURE));
    }
    // Establishing and proving are the same command's job: a DACL that did
    // not take is indistinguishable from one never asked for.
    verify_owner_only_for(path, &owner, false, None)
}

pub fn secure_directory(path: &str) -> Result<(), NativeError> {
    secure_directory_for_owner(path, current_user_sid()?, false)
}

pub fn secure_service_directory(path: &str) -> Result<(), NativeError> {
    secure_directory_for_owner(path, service_sid()?, true)
}

/// Every ACE of a protected DACL, read once. A NULL DACL is world-writable
/// and an empty one is not: absence of the pointer is the failure.
fn admits_only(acl: *const ACL, user: &OwnedSid, system: &OwnedSid, allow_inherited: bool) -> bool {
    if acl.is_null() {
        return false;
    }
    let count = unsafe { (*acl).AceCount };
    for index in 0..count {
        let mut ace: *mut std::ffi::c_void = std::ptr::null_mut();
        if unsafe { GetAce(acl, u32::from(index), &mut ace) } == 0 || ace.is_null() {
            return false;
        }
        let entry = ace.cast::<ACCESS_ALLOWED_ACE>();
        let header = unsafe { (*entry).Header };
        if header.AceType != ACCESS_ALLOWED
            || (!allow_inherited && u32::from(header.AceFlags) & INHERITED_ACE != 0)
        {
            return false;
        }
        let sid = unsafe { std::ptr::addr_of!((*entry).SidStart) } as PSID;
        if unsafe { IsValidSid(sid) } == 0 {
            return false;
        }
        let admitted = unsafe { EqualSid(sid, user.pointer()) } != 0
            || unsafe { EqualSid(sid, system.pointer()) } != 0;
        if !admitted {
            return false;
        }
    }
    true
}

/// `creator_owner` is the second SID an owner may be: the one this token
/// stamps on what it creates. It is `None` wherever the helper stamped the
/// owner itself — a directory it secured must be owned by exactly the SID
/// it wrote, and accepting a second answer there would hide a DACL that
/// never took.
fn verify_owner_only_for(
    path: &str,
    user: &OwnedSid,
    allow_inherited: bool,
    creator_owner: Option<&OwnedSid>,
) -> Result<(), NativeError> {
    let system = local_system_sid()?;
    let mut owner: PSID = std::ptr::null_mut();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let read = unsafe {
        GetNamedSecurityInfoW(
            wide(path).as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if read != ERROR_SUCCESS {
        return Err(path_error(read));
    }
    let mut control = 0_u16;
    let mut revision = 0_u32;
    let described =
        unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } != 0;
    let owned = !owner.is_null()
        && unsafe { IsValidSid(owner) } != 0
        && (unsafe { EqualSid(owner, user.pointer()) } != 0
            || creator_owner
                .is_some_and(|creator| unsafe { EqualSid(owner, creator.pointer()) } != 0));
    let verdict = described
        && owned
        && (allow_inherited || control & SE_DACL_PROTECTED != 0)
        && admits_only(dacl, user, &system, allow_inherited);
    unsafe { LocalFree(descriptor as HLOCAL) };
    if verdict {
        Ok(())
    } else {
        Err(NativeError::new(REJECTED))
    }
}

/// A directory this helper secured, whose owner it stamped itself, so the
/// owner must be exactly the token user.
pub fn verify_owner_only(path: &str) -> Result<(), NativeError> {
    verify_owner_only_for(path, &current_user_sid()?, false, None)
}

/// A file the supervisor created with an ordinary `open`, so Windows — not
/// this helper — chose its owner, and chose the token's owner SID.
pub fn verify_owner_only_file(path: &str) -> Result<(), NativeError> {
    let creator = token_owner_sid()?;
    verify_owner_only_for(path, &current_user_sid()?, true, Some(&creator))
}

/// Preserve the proven private DACL and stamp only the account's SID. Accepting
/// this token's default creator owner first lets an elevated writer normalize
/// its own new file; it never adopts another account's file or broadens access.
pub fn secure_owner_only_file(path: &str) -> Result<(), NativeError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        NativeError::new(if error.kind() == std::io::ErrorKind::NotFound { NOT_FOUND } else { IO_FAILURE })
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(NativeError::new(REJECTED));
    }
    let user = current_user_sid()?;
    let creator = token_owner_sid()?;
    verify_owner_only_for(path, &user, true, Some(&creator))?;
    let applied = unsafe {
        SetNamedSecurityInfoW(
            wide(path).as_ptr(), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
            user.pointer(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null(),
        )
    };
    if applied != ERROR_SUCCESS { return Err(NativeError::new(IO_FAILURE)); }
    verify_owner_only_for(path, &user, true, None)
}

#[cfg(test)]
mod file_owner_tests {
    use super::*;

    #[test]
    fn only_windows_missing_path_errors_are_absence() {
        assert_eq!(path_error(ERROR_FILE_NOT_FOUND).code, NOT_FOUND);
        assert_eq!(path_error(ERROR_PATH_NOT_FOUND).code, NOT_FOUND);
        assert_eq!(path_error(windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED).code, IO_FAILURE);
    }

    #[test]
    fn a_file_removed_before_its_native_dacl_read_is_missing_not_unsafe() {
        let root = tempfile::tempdir().expect("test directory");
        let file = root.path().join("mutation.lock");
        secure_directory(root.path().to_str().unwrap()).expect("private parent");
        std::fs::write(&file, b"1").expect("lock creation");
        std::fs::remove_file(&file).expect("owner released lock");
        assert_eq!(verify_owner_only_file(file.to_str().unwrap()).unwrap_err().code, NOT_FOUND);
        assert_eq!(secure_owner_only_file(file.to_str().unwrap()).unwrap_err().code, NOT_FOUND);
        assert_eq!(verify_owner_only(root.path().join("missing").to_str().unwrap()).unwrap_err().code, NOT_FOUND);
    }

    #[test]
    fn a_private_write_is_owned_by_the_account_regardless_of_its_default_owner() {
        let root = std::env::temp_dir().join(format!("nessie-stamped-owner-{}", std::process::id()));
        secure_directory(root.to_str().unwrap()).expect("private parent");
        let file = root.join("private.json");
        std::fs::write(&file, b"{}").expect("private write");
        secure_owner_only_file(file.to_str().unwrap()).expect("normalize creator owner");
        verify_owner_only_for(file.to_str().unwrap(), &current_user_sid().unwrap(), true, None)
            .expect("the account alone owns the persisted file, without accepting the token owner");
        let broad = root.join("broad.json");
        std::fs::write(&broad, b"{}").expect("write");
        let grant = std::process::Command::new("icacls").arg(&broad)
            .args(["/grant", "*S-1-1-0:R"]).output().expect("icacls");
        assert!(grant.status.success());
        assert_eq!(secure_owner_only_file(broad.to_str().unwrap()).unwrap_err().code, REJECTED);
        assert_eq!(secure_owner_only_file(root.to_str().unwrap()).unwrap_err().code, REJECTED);
        std::fs::remove_dir_all(root).ok();
    }
}
