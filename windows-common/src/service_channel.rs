//! Authenticate the actual pipe server before sending companion proof.
use std::io::{BufRead, BufReader, Read, Write};

pub fn call(
    operation: &crate::custody::Operation,
    pin: Option<&str>,
) -> Result<serde_json::Value, String> {
    use std::{
        fs::File,
        os::windows::{ffi::OsStrExt, io::FromRawHandle},
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING},
        System::Pipes::WaitNamedPipeW,
    };
    crate::custody::validate(operation)?;
    let name: Vec<u16> = std::ffi::OsStr::new(r"\\.\pipe\NessieExecutor")
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe { WaitNamedPipeW(name.as_ptr(), 5000) };
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            crate::CONTROL_PIPE_CLIENT_ACCESS,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        return Err(crate::custody::REJECTED.into());
    }
    if let Err(error) = verify(handle, pin) {
        unsafe { CloseHandle(handle) };
        return Err(error);
    }
    let mut file = unsafe { File::from_raw_handle(handle.cast()) };
    let request = serde_json::json!({"command":"managedCustody", "operation":operation});
    let mut bytes = serde_json::to_vec(&request).map_err(|_| crate::custody::REJECTED)?;
    bytes.push(b'\n');
    file.write_all(&bytes)
        .and_then(|()| file.flush())
        .map_err(|_| crate::custody::REJECTED)?;
    let mut frame = Vec::new();
    BufReader::new(file.take(1_048_577))
        .read_until(b'\n', &mut frame)
        .map_err(|_| crate::custody::REJECTED)?;
    if !frame.ends_with(b"\n") || frame.len() > 1_048_576 {
        return Err(crate::custody::REJECTED.into());
    }
    let response: serde_json::Value =
        serde_json::from_slice(&frame).map_err(|_| crate::custody::REJECTED)?;
    if response["status"] != "managedCustody" {
        return Err(crate::custody::REJECTED.into());
    }
    Ok(response["custody"].clone())
}
#[cfg(windows)]
pub fn verify(
    pipe: windows_sys::Win32::Foundation::HANDLE,
    pin: Option<&str>,
) -> Result<(), String> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt, path::PathBuf};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, WAIT_TIMEOUT},
        Security::{
            GetTokenInformation, IsWellKnownSid, TokenSessionId, TokenUser, WinLocalSystemSid,
            TOKEN_QUERY, TOKEN_USER,
        },
        System::{
            Pipes::GetNamedPipeServerProcessId,
            Threading::{
                OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, WaitForSingleObject,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
    };
    let refused = || "The personal attestation pipe is not the trusted Nessie service.".to_owned();
    let mut pid = 0;
    if unsafe { GetNamedPipeServerProcessId(pipe, &mut pid) } == 0 || pid == 0 {
        return Err(refused());
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | 0x0010_0000, 0, pid) };
    if process.is_null() {
        return Err(refused());
    }
    let result = (|| {
        if unsafe { WaitForSingleObject(process, 0) } != WAIT_TIMEOUT {
            return Err(refused());
        }
        let mut token: HANDLE = std::ptr::null_mut();
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return Err(refused());
        }
        let token_result = (|| {
            let mut size = 0;
            let mut session = u32::MAX;
            if unsafe {
                GetTokenInformation(
                    token,
                    TokenSessionId,
                    (&mut session as *mut u32).cast(),
                    std::mem::size_of::<u32>() as u32,
                    &mut size,
                )
            } == 0
                || session != 0
            {
                return Err(refused());
            }
            unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size) };
            let mut bytes = vec![0_u8; size as usize];
            if bytes.is_empty()
                || unsafe {
                    GetTokenInformation(
                        token,
                        TokenUser,
                        bytes.as_mut_ptr().cast(),
                        size,
                        &mut size,
                    )
                } == 0
            {
                return Err(refused());
            }
            let sid = unsafe { (*bytes.as_ptr().cast::<TOKEN_USER>()).User.Sid };
            if unsafe { IsWellKnownSid(sid, WinLocalSystemSid) } == 0 {
                let actual = crate::sid_to_string(sid).ok_or_else(refused)?;
                // The virtual account's SID is derived by Windows, not by a
                // caller's asserted administrator role or an environment value.
                let expected = service_account_sid()?;
                if actual != expected {
                    return Err(refused());
                }
            }
            Ok(())
        })();
        unsafe { CloseHandle(token) };
        token_result?;
        let mut image = vec![0_u16; 32_768];
        let mut length = image.len() as u32;
        if unsafe { QueryFullProcessImageNameW(process, 0, image.as_mut_ptr(), &mut length) } == 0
            || length == 0
        {
            return Err(refused());
        }
        let path = PathBuf::from(OsString::from_wide(&image[..length as usize]));
        if path.file_name().and_then(|name| name.to_str()) != Some("nessie-executor-service.exe") {
            return Err(refused());
        }
        let facts =
            nessie_windows_provenance::collect_signature_facts(&path).ok_or_else(refused)?;
        nessie_windows_provenance::decide_release_signature(pin, Some(facts))?;
        let mut still_pid = 0;
        if unsafe { GetNamedPipeServerProcessId(pipe, &mut still_pid) } == 0
            || still_pid != pid
            || unsafe { WaitForSingleObject(process, 0) } != WAIT_TIMEOUT
        {
            return Err(refused());
        }
        Ok(())
    })();
    unsafe { CloseHandle(process) };
    result
}

#[cfg(windows)]
pub fn service_account_sid() -> Result<String, String> {
    account_sid(crate::SERVICE_ACCOUNT)
}
pub(crate) fn account_sid(account: &str) -> Result<String, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::{LookupAccountNameW, SID_NAME_USE};
    let name: Vec<u16> = std::ffi::OsStr::new(account)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let (mut size, mut domain_size, mut kind) = (0, 0, 0 as SID_NAME_USE);
    unsafe {
        LookupAccountNameW(
            std::ptr::null(),
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            &mut domain_size,
            &mut kind,
        )
    };
    let mut sid = vec![0_u8; size as usize];
    let mut domain = vec![0_u16; domain_size as usize];
    if sid.is_empty()
        || unsafe {
            LookupAccountNameW(
                std::ptr::null(),
                name.as_ptr(),
                sid.as_mut_ptr().cast(),
                &mut size,
                domain.as_mut_ptr(),
                &mut domain_size,
                &mut kind,
            )
        } == 0
    {
        return Err("The installed Nessie service account is unavailable.".into());
    }
    crate::sid_to_string(sid.as_mut_ptr().cast())
        .ok_or_else(|| "The installed Nessie service account is unavailable.".into())
}

#[cfg(all(test, windows))]
mod tests {
    use super::verify;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
        },
        System::Pipes::{CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT},
    };

    #[test]
    fn a_user_owned_lookalike_pipe_cannot_receive_companion_proof() {
        let name = format!(r"\\.\pipe\NessiePeerNegative-{}", std::process::id());
        let wide: Vec<u16> = std::ffi::OsStr::new(&name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let server = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,
                4096,
                4096,
                0,
                std::ptr::null(),
            )
        };
        assert_ne!(server, INVALID_HANDLE_VALUE);
        let client = unsafe {
            CreateFileW(
                wide.as_ptr(),
                crate::CONTROL_PIPE_CLIENT_ACCESS,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(client, INVALID_HANDLE_VALUE);
        let refused = verify(client, None);
        unsafe {
            CloseHandle(client);
            CloseHandle(server);
        }
        assert!(refused.is_err());
    }
}
