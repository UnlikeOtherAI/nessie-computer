//! Minimal retained-handle observations for lifecycle files, not custody grants.
use super::{lease::ProcessFact, process::Owned};
use std::{fs::File, os::windows::io::AsRawHandle};
use windows_sys::Win32::{
    Foundation::{
        GetLastError, LocalFree, ERROR_INVALID_PARAMETER, FILETIME, HANDLE, STILL_ACTIVE,
    },
    Security::{
        Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
        GetTokenInformation, TokenUser, OWNER_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
    },
    System::Threading::{
        GetCurrentProcess, GetExitCodeProcess, GetProcessTimes, OpenProcess, OpenProcessToken,
        PROCESS_QUERY_LIMITED_INFORMATION,
    },
};

pub(super) fn file_owner_sid(file: &File) -> Option<String> {
    let mut owner = std::ptr::null_mut();
    let mut descriptor = std::ptr::null_mut();
    let result = unsafe {
        GetSecurityInfo(
            file.as_raw_handle() as HANDLE,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if result != 0 || descriptor.is_null() {
        return None;
    }
    let sid = crate::sid_to_string(owner);
    unsafe { LocalFree(descriptor) };
    sid
}

pub(super) fn file_owner(file: &File) -> Option<String> {
    let sid = file_owner_sid(file);
    // A group owner (for example Administrators) is not one lifecycle principal.
    // Retirement needs the same owner-account proof the CLI uses.
    sid.filter(|owner| process_sid(unsafe { GetCurrentProcess() }).as_ref() == Some(owner))
}

fn process_sid(handle: HANDLE) -> Option<String> {
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(handle, TOKEN_QUERY, &mut token) } == 0 {
        return None;
    }
    let token = Owned(token);
    let mut length = 0;
    unsafe { GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut length) };
    if length == 0 || length > 65_536 {
        return None;
    }
    let mut bytes = vec![0_usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            bytes.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return None;
    }
    crate::sid_to_string(unsafe { (*bytes.as_ptr().cast::<TOKEN_USER>()).User.Sid })
}

pub(super) fn observe(pid: u32) -> ProcessFact {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
            ProcessFact::Absent
        } else {
            ProcessFact::Unknown
        };
    }
    let handle = Owned(handle);
    let mut exit = 0;
    if unsafe { GetExitCodeProcess(handle.0, &mut exit) } == 0 {
        return ProcessFact::Unknown;
    }
    if exit != STILL_ACTIVE as u32 {
        return ProcessFact::Absent;
    }
    let mut times = [FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    }; 4];
    let [created, exited, kernel, user] = &mut times;
    if unsafe { GetProcessTimes(handle.0, created, exited, kernel, user) } == 0 {
        return ProcessFact::Unknown;
    }
    let started_at =
        (((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64).to_string();
    // The open kernel handle pins this process through the token read, even
    // if its numeric PID is reused meanwhile. No terminate/signal right exists.
    ProcessFact::Present {
        started_at,
        sid: process_sid(handle.0),
    }
}
