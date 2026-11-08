//! Required execution authority isolation. Current ACLs supplement, never replace,
//! recorded creation by the fixed SYSTEM supervisor. An ordinary same-user
//! managed-runtime record cannot pass this gate.
use crate::{
    custody::REJECTED,
    process::{Owned, Process},
};
use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::{
        Authorization::{GetSecurityInfo, SE_KERNEL_OBJECT},
        GetAce, GetTokenInformation, TokenDefaultDacl, ACCESS_ALLOWED_ACE, ACL,
        DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, TOKEN_DEFAULT_DACL,
    },
    Storage::FileSystem::READ_CONTROL,
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        Threading::{
            GetProcessMitigationPolicy, OpenProcess, OpenProcessToken, OpenThread,
            ProcessExtensionPointDisablePolicy, ProcessSignaturePolicy,
            PROCESS_QUERY_LIMITED_INFORMATION, THREAD_QUERY_LIMITED_INFORMATION,
        },
    },
};
const QUERY_SYNC: u32 = 0x0012_1000;
fn allowed(acl: *mut ACL, service: &str, limited: u32, owner_rights: bool) -> Result<(), String> {
    if acl.is_null() || unsafe { (*acl).AceCount } > 32 {
        return Err(REJECTED.into());
    }
    let mut has_owner_rights = false;
    for i in 0..unsafe { (*acl).AceCount } as u32 {
        let mut pointer = std::ptr::null_mut();
        if unsafe { GetAce(acl, i, &mut pointer) } == 0 || pointer.is_null() {
            return Err(REJECTED.into());
        }
        let ace = unsafe { &*pointer.cast::<ACCESS_ALLOWED_ACE>() };
        if ace.Header.AceType != 0 || ace.Header.AceFlags != 0 {
            return Err(REJECTED.into());
        }
        let sid = crate::sid_to_string((&ace.SidStart as *const u32).cast_mut().cast())
            .ok_or(REJECTED)?;
        match sid.as_str() {
            "S-1-5-18" => {}
            s if s == service => {}
            "S-1-5-11" if ace.Mask & !limited == 0 => {}
            "S-1-3-4" if ace.Mask == READ_CONTROL => {
                has_owner_rights = true;
            }
            _ => return Err(REJECTED.into()),
        }
    }
    if owner_rights && !has_owner_rights {
        return Err(REJECTED.into());
    }
    Ok(())
}
fn object(
    handle: HANDLE,
    service: &str,
    limited: u32,
    thread_owner: Option<&str>,
) -> Result<(), String> {
    let mut owner = std::ptr::null_mut();
    let mut acl = std::ptr::null_mut();
    let mut descriptor = std::ptr::null_mut();
    if unsafe {
        GetSecurityInfo(
            handle,
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut acl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    } != 0
        || descriptor.is_null()
    {
        return Err(REJECTED.into());
    }
    let result = (|| {
        let sid = crate::sid_to_string(owner).ok_or(REJECTED)?;
        let user_owner = sid != "S-1-5-18" && sid != service;
        if user_owner && Some(sid.as_str()) != thread_owner {
            return Err(REJECTED.into());
        }
        allowed(acl, service, limited, user_owner)
    })();
    unsafe { LocalFree(descriptor) };
    result
}
pub fn verify(process: &Process) -> Result<(), String> {
    let service = crate::service_channel::service_account_sid()?;
    let handle = Owned(unsafe {
        OpenProcess(
            READ_CONTROL | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            process.generation.pid,
        )
    });
    if handle.0.is_null() {
        return Err(REJECTED.into());
    }
    object(handle.0, &service, QUERY_SYNC, None)?;
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(handle.0, READ_CONTROL | 8, &mut token) } == 0 {
        return Err(REJECTED.into());
    }
    let token = Owned(token);
    object(token.0, &service, READ_CONTROL | 8, None)?;
    let mut size = 0;
    unsafe {
        GetTokenInformation(
            token.0,
            TokenDefaultDacl,
            std::ptr::null_mut(),
            0,
            &mut size,
        )
    };
    if size == 0 || size > 65536 {
        return Err(REJECTED.into());
    }
    let mut bytes = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenDefaultDacl,
            bytes.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(REJECTED.into());
    }
    // New threads may only be queried/synchronized, and OW suppresses implicit WRITE_DAC.
    allowed(
        unsafe { (*bytes.as_ptr().cast::<TOKEN_DEFAULT_DACL>()).DefaultDacl },
        &service,
        0x00120800,
        true,
    )?;
    for policy in [ProcessSignaturePolicy, ProcessExtensionPointDisablePolicy] {
        let mut flags = 0u32;
        if unsafe {
            GetProcessMitigationPolicy(handle.0, policy, (&mut flags as *mut u32).cast(), 4)
        } == 0
            || flags & 1 == 0
        {
            return Err(REJECTED.into());
        }
    }
    let snapshot = Owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) });
    if snapshot.0 == INVALID_HANDLE_VALUE {
        return Err(REJECTED.into());
    }
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut more = unsafe { Thread32First(snapshot.0, &mut entry) } != 0;
    let mut count = 0;
    while more {
        if entry.th32OwnerProcessID == process.generation.pid {
            let thread = Owned(unsafe {
                OpenThread(
                    READ_CONTROL | THREAD_QUERY_LIMITED_INFORMATION,
                    0,
                    entry.th32ThreadID,
                )
            });
            if thread.0.is_null() {
                return Err(REJECTED.into());
            }
            object(thread.0, &service, 0x00120800, Some(&process.sid))?;
            count += 1;
        }
        more = unsafe { Thread32Next(snapshot.0, &mut entry) } != 0;
    }
    if count == 0 || !process.alive() {
        return Err(REJECTED.into());
    }
    Ok(())
}
