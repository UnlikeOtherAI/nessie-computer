//! Publish read-only kernel facts required to authenticate the SYSTEM pipe server.
use nessie_executor_updater::catalog::UpdateResult;
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree, HANDLE},
    Security::{
        Authorization::{
            ConvertStringSidToSidW, SetEntriesInAclW, EXPLICIT_ACCESS_W, GRANT_ACCESS,
            NO_MULTIPLE_TRUSTEE, TRUSTEE_IS_SID, TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_W,
        },
        GetKernelObjectSecurity, GetSecurityDescriptorDacl, InitializeSecurityDescriptor,
        SetKernelObjectSecurity, SetSecurityDescriptorDacl, ACL, DACL_SECURITY_INFORMATION,
        NO_INHERITANCE, SECURITY_DESCRIPTOR, TOKEN_QUERY,
    },
    Storage::FileSystem::{READ_CONTROL, WRITE_DAC},
    System::Threading::{
        GetCurrentProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    },
};
const ERROR: &str = "update.peer_inspection_unavailable";

/// Called only after the installed SYSTEM/session-0 worker has been verified.
/// Clients retain the same process, token, publisher and protected-image checks.
/// No terminate, memory, handle-duplication, impersonation or ACL-write access is added.
pub(super) fn allow_verification() -> UpdateResult<()> {
    let process = unsafe { GetCurrentProcess() };
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(process, READ_CONTROL | WRITE_DAC, &mut token) } == 0 {
        return Err(ERROR);
    }
    let result = grant_read(token, TOKEN_QUERY).and_then(|()| {
        grant_read(
            process,
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
        )
    });
    unsafe { CloseHandle(token) };
    result
}

struct Local(*mut std::ffi::c_void);
impl Drop for Local {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { LocalFree(self.0) };
        }
    }
}

fn grant_read(object: HANDLE, rights: u32) -> UpdateResult<()> {
    let mut length = 0;
    unsafe {
        GetKernelObjectSecurity(
            object,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            0,
            &mut length,
        )
    };
    if length == 0 || length > 1_048_576 {
        return Err(ERROR);
    }
    let mut current = vec![0_u8; length as usize];
    if unsafe {
        GetKernelObjectSecurity(
            object,
            DACL_SECURITY_INFORMATION,
            current.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err(ERROR);
    }
    let (mut present, mut defaulted, mut acl) = (0, 0, std::ptr::null_mut());
    if unsafe {
        GetSecurityDescriptorDacl(
            current.as_mut_ptr().cast(),
            &mut present,
            &mut acl,
            &mut defaulted,
        )
    } == 0
        || present == 0
        || acl.is_null()
    {
        return Err(ERROR);
    }
    let sid_text: Vec<u16> = "S-1-5-11".encode_utf16().chain(Some(0)).collect();
    let mut sid = std::ptr::null_mut();
    if unsafe { ConvertStringSidToSidW(sid_text.as_ptr(), &mut sid) } == 0 {
        return Err(ERROR);
    }
    let _sid = Local(sid);
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: rights,
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: NO_INHERITANCE,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
            ptstrName: sid.cast(),
        },
    };
    let mut merged: *mut ACL = std::ptr::null_mut();
    let merged_result = unsafe { SetEntriesInAclW(1, &entry, acl, &mut merged) };
    let _merged = Local(merged.cast());
    if merged_result != 0 || merged.is_null() {
        return Err(ERROR);
    }
    let mut descriptor: SECURITY_DESCRIPTOR = unsafe { std::mem::zeroed() };
    let pointer = (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast();
    if unsafe { InitializeSecurityDescriptor(pointer, 1) } == 0
        || unsafe { SetSecurityDescriptorDacl(pointer, 1, merged, 0) } == 0
        || unsafe { SetKernelObjectSecurity(object, DACL_SECURITY_INFORMATION, pointer) } == 0
    {
        return Err(ERROR);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::windows::{io::AsRawHandle, process::CommandExt},
        process::Command,
    };
    use windows_sys::Win32::{
        Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, GetEffectiveRightsFromAclW,
        },
        Security::{
            DuplicateTokenEx, SecurityImpersonation, TokenPrimary, TOKEN_ALL_ACCESS,
            TOKEN_DUPLICATE,
        },
        System::Threading::{CREATE_SUSPENDED, PROCESS_ALL_ACCESS},
    };

    fn prepare(object: HANDLE) {
        // Both owned test objects are inert; existing handles retain their rights.
        let text: Vec<u16> = "D:P(A;;GA;;;SY)(A;;GA;;;BA)"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    text.as_ptr(),
                    1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        let _descriptor = Local(descriptor);
        assert_ne!(
            unsafe { SetKernelObjectSecurity(object, DACL_SECURITY_INFORMATION, descriptor) },
            0
        );
    }

    fn rights(object: HANDLE, trustee: &str) -> u32 {
        let mut length = 0;
        unsafe {
            GetKernelObjectSecurity(
                object,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                0,
                &mut length,
            )
        };
        let mut bytes = vec![0_u8; length as usize];
        assert_ne!(
            unsafe {
                GetKernelObjectSecurity(
                    object,
                    DACL_SECURITY_INFORMATION,
                    bytes.as_mut_ptr().cast(),
                    length,
                    &mut length,
                )
            },
            0
        );
        let (mut present, mut defaulted, mut acl) = (0, 0, std::ptr::null_mut());
        assert_ne!(
            unsafe {
                GetSecurityDescriptorDacl(
                    bytes.as_mut_ptr().cast(),
                    &mut present,
                    &mut acl,
                    &mut defaulted,
                )
            },
            0
        );
        let text: Vec<u16> = trustee.encode_utf16().chain(Some(0)).collect();
        let mut sid = std::ptr::null_mut();
        assert_ne!(
            unsafe { ConvertStringSidToSidW(text.as_ptr(), &mut sid) },
            0
        );
        let _sid = Local(sid);
        let trustee = TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
            ptstrName: sid.cast(),
        };
        let mut result = 0;
        assert_eq!(
            unsafe { GetEffectiveRightsFromAclW(acl, &trustee, &mut result) },
            0
        );
        result
    }

    #[test]
    fn kernel_process_and_private_token_allow_inspection_without_control() {
        // The child never executes a single instruction or hosts a test service.
        let child = Command::new(std::env::current_exe().unwrap())
            .creation_flags(CREATE_SUSPENDED)
            .spawn()
            .unwrap();
        struct Stop(std::process::Child);
        impl Drop for Stop {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let child = Stop(child);
        let process = child.0.as_raw_handle().cast();
        prepare(process);
        let system_before = rights(process, "S-1-5-18");
        let allowed = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
        grant_read(process, allowed).unwrap();
        grant_read(process, allowed).unwrap();
        assert_eq!(rights(process, "S-1-5-11"), allowed);
        assert_eq!(rights(process, "S-1-5-18"), system_before);
        assert_ne!(rights(process, "S-1-5-11"), PROCESS_ALL_ACCESS);

        let mut own = std::ptr::null_mut();
        assert_ne!(
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE, &mut own) },
            0
        );
        let mut private = std::ptr::null_mut();
        let duplicated = unsafe {
            DuplicateTokenEx(
                own,
                TOKEN_ALL_ACCESS,
                std::ptr::null(),
                SecurityImpersonation,
                TokenPrimary,
                &mut private,
            )
        };
        unsafe { CloseHandle(own) };
        assert_ne!(duplicated, 0);
        struct Token(HANDLE);
        impl Drop for Token {
            fn drop(&mut self) {
                unsafe { CloseHandle(self.0) };
            }
        }
        let private = Token(private);
        prepare(private.0);
        let system_before = rights(private.0, "S-1-5-18");
        grant_read(private.0, TOKEN_QUERY).unwrap();
        assert_eq!(rights(private.0, "S-1-5-11"), TOKEN_QUERY);
        assert_eq!(rights(private.0, "S-1-5-18"), system_before);
    }
}
