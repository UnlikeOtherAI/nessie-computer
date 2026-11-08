//! Starts the Windows app in a person's own interactive session, as that
//! person and never elevated, from a SYSTEM process: the updater after it
//! replaced a release, and the installer after it replaced the files.
use crate::{
    custody::{Generation, REJECTED},
    process::{self, Owned, Process},
};
use std::{ffi::OsStr, mem::size_of, os::windows::ffi::OsStrExt, path::Path};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    Security::{GetTokenInformation, TokenUser, TOKEN_USER},
    System::{
        Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock},
        RemoteDesktop::WTSQueryUserToken,
        Threading::{
            CreateProcessAsUserW, TerminateProcess, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION,
            STARTUPINFOW,
        },
    },
};

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn token_sid(token: HANDLE) -> Result<String, String> {
    let mut length = 0;
    unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut length) };
    if length == 0 || length > 65_536 {
        return Err(REJECTED.into());
    }
    let mut buffer = vec![0_usize; (length as usize).div_ceil(size_of::<usize>())];
    if unsafe { GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), length, &mut length) } == 0 {
        return Err(REJECTED.into());
    }
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    crate::sid_to_string(user.User.Sid).ok_or_else(|| REJECTED.to_owned())
}

/// The person's own environment, cut to the variables the app needs.
fn environment(token: HANDLE) -> Result<Vec<u16>, String> {
    let mut pointer = std::ptr::null_mut();
    if unsafe { CreateEnvironmentBlock(&mut pointer, token, 0) } == 0 {
        return Err(REJECTED.into());
    }
    let result = (|| {
        let mut offset = 0;
        let mut filtered = Vec::new();
        while offset < 131_072 {
            let start = offset;
            while offset < 131_072 && unsafe { *pointer.cast::<u16>().add(offset) } != 0 {
                offset += 1;
            }
            if offset >= 131_072 {
                return Err(REJECTED.to_owned());
            }
            if start == offset {
                filtered.push(0);
                return Ok(filtered);
            }
            let entry = unsafe { std::slice::from_raw_parts(pointer.cast::<u16>().add(start), offset - start) };
            let text = String::from_utf16(entry).map_err(|_| REJECTED)?;
            let key = text.split_once('=').map(|value| value.0.to_ascii_uppercase());
            if key.as_deref().is_some_and(|key| matches!(key, "USERPROFILE" | "APPDATA" | "LOCALAPPDATA"
                | "TEMP" | "TMP" | "HOMEDRIVE" | "HOMEPATH" | "USERNAME" | "USERDOMAIN"
                | "PATH" | "SYSTEMROOT" | "WINDIR")) {
                filtered.extend_from_slice(entry);
                filtered.push(0);
            }
            offset += 1;
        }
        Err(REJECTED.to_owned())
    })();
    unsafe { DestroyEnvironmentBlock(pointer) };
    result
}

/// Starts `executable` in `session` as `owner_sid`, who must still be the
/// person signed in there. The started process must be that person's,
/// unelevated, from exactly that file and signed by the release publisher;
/// otherwise it is stopped again.
pub fn launch_app(owner_sid: &str, session: u32, executable: &Path, pin: Option<&str>) -> Result<Generation, String> {
    if process::session_owner(session)? != owner_sid {
        return Err(REJECTED.into());
    }
    let mut token = std::ptr::null_mut();
    if unsafe { WTSQueryUserToken(session, &mut token) } == 0 {
        return Err(REJECTED.into());
    }
    let token = Owned(token);
    if token_sid(token.0)? != owner_sid {
        return Err(REJECTED.into());
    }
    let mut environment = environment(token.0)?;
    let image = wide(executable.as_os_str());
    let mut arguments = wide(OsStr::new(&format!("\"{}\"", executable.display())));
    let mut desktop = wide(OsStr::new("winsta0\\default"));
    let directory = wide(executable.parent().ok_or(REJECTED)?.as_os_str());
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    startup.lpDesktop = desktop.as_mut_ptr();
    let mut created: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe {
        CreateProcessAsUserW(token.0, image.as_ptr(), arguments.as_mut_ptr(), std::ptr::null(),
            std::ptr::null(), 0, CREATE_UNICODE_ENVIRONMENT, environment.as_mut_ptr().cast(),
            directory.as_ptr(), &startup, &mut created)
    } == 0
    {
        return Err(REJECTED.into());
    }
    let handle = Owned(created.hProcess);
    unsafe { CloseHandle(created.hThread) };
    let process = Process::open(created.dwProcessId)?;
    if !process.alive() || process.sid != owner_sid || process.session != session || process.elevated
        || process.image != executable
    {
        unsafe { TerminateProcess(handle.0, 1) };
        return Err(REJECTED.into());
    }
    if process.signed(pin).is_err() {
        unsafe { TerminateProcess(handle.0, 1) };
        return Err(REJECTED.into());
    }
    Ok(process.generation)
}
