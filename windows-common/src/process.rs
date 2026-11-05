//! Retained kernel facts used by custody; PID strings and caller claims grant nothing.
use crate::custody::{Generation, REJECTED};
use std::{ffi::OsString, os::windows::ffi::OsStringExt, path::PathBuf};
use windows_sys::Win32::{
    Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_TIMEOUT},
    Security::{
        GetTokenInformation, TokenElevation, TokenSessionId, TokenUser, TOKEN_ELEVATION,
        TOKEN_QUERY, TOKEN_USER,
    },
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        Threading::{
            GetProcessTimes, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
            WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        },
    },
};

pub struct Owned(pub HANDLE);
unsafe impl Send for Owned {}
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

pub fn boot_id() -> Result<String, String> {
    #[repr(C)]
    struct Boot {
        id: windows_sys::core::GUID,
        firmware: u32,
        flags: u64,
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn NtQuerySystemInformation(
            class: u32,
            value: *mut std::ffi::c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
    }
    let mut value = std::mem::MaybeUninit::<Boot>::zeroed();
    let mut returned = 0;
    let size = std::mem::size_of::<Boot>() as u32;
    if unsafe { NtQuerySystemInformation(0x5a, value.as_mut_ptr().cast(), size, &mut returned) }
        != 0
        || returned != size
    {
        return Err(REJECTED.into());
    }
    let id = unsafe { value.assume_init() }.id;
    Ok(format!(
        "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        id.data1,
        id.data2,
        id.data3,
        id.data4[0],
        id.data4[1],
        id.data4[2],
        id.data4[3],
        id.data4[4],
        id.data4[5],
        id.data4[6],
        id.data4[7]
    ))
}

pub struct Process {
    pub handle: Owned,
    pub generation: Generation,
    pub image: PathBuf,
    pub sid: String,
    pub session: u32,
    pub elevated: bool,
}
impl Process {
    pub fn open(pid: u32) -> Result<Self, String> {
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return Err(REJECTED.into());
        }
        let handle = Owned(handle);
        let mut times = [FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        }; 4];
        let [created, exited, kernel, user] = &mut times;
        if unsafe { GetProcessTimes(handle.0, created, exited, kernel, user) } == 0 {
            return Err(REJECTED.into());
        }
        let generation = Generation {
            pid,
            boot_id: boot_id()?,
            started_at: (((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
                .to_string(),
        };
        let mut image = vec![0_u16; 32_768];
        let mut length = image.len() as u32;
        if unsafe { QueryFullProcessImageNameW(handle.0, 0, image.as_mut_ptr(), &mut length) } == 0
            || length == 0
        {
            return Err(REJECTED.into());
        }
        let image = PathBuf::from(OsString::from_wide(&image[..length as usize]));
        let mut token = std::ptr::null_mut();
        if unsafe { OpenProcessToken(handle.0, TOKEN_QUERY, &mut token) } == 0 {
            return Err(REJECTED.into());
        }
        let token = Owned(token);
        let mut size = 0;
        unsafe { GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut size) };
        if size == 0 || size > 65_536 {
            return Err(REJECTED.into());
        }
        let mut bytes = vec![0_u8; size as usize];
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                bytes.as_mut_ptr().cast(),
                size,
                &mut size,
            )
        } == 0
        {
            return Err(REJECTED.into());
        }
        let sid = crate::sid_to_string(unsafe { (*bytes.as_ptr().cast::<TOKEN_USER>()).User.Sid })
            .ok_or(REJECTED)?;
        let mut session = u32::MAX;
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 1 };
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenSessionId,
                (&mut session as *mut u32).cast(),
                std::mem::size_of::<u32>() as u32,
                &mut size,
            )
        } == 0
            || unsafe {
                GetTokenInformation(
                    token.0,
                    TokenElevation,
                    (&mut elevation as *mut TOKEN_ELEVATION).cast(),
                    std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                    &mut size,
                )
            } == 0
        {
            return Err(REJECTED.into());
        }
        Ok(Self {
            handle,
            generation,
            image,
            sid,
            session,
            elevated: elevation.TokenIsElevated != 0,
        })
    }
    pub fn alive(&self) -> bool {
        (unsafe { WaitForSingleObject(self.handle.0, 0) }) == WAIT_TIMEOUT
    }
    pub fn signed(&self, pin: Option<&str>) -> Result<(), String> {
        nessie_windows_provenance::decide_release_signature(
            pin,
            nessie_windows_provenance::collect_signature_facts(&self.image),
        )
    }
}

pub struct Entry {
    pub pid: u32,
    pub parent: u32,
    pub name: String,
}
pub fn snapshot() -> Result<Vec<Entry>, String> {
    let handle = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        return Err(REJECTED.into());
    }
    let handle = Owned(handle);
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut entries = Vec::new();
    let mut more = unsafe { Process32FirstW(handle.0, &mut entry) } != 0;
    if !more {
        return Err(REJECTED.into());
    }
    while more {
        let length = entry
            .szExeFile
            .iter()
            .position(|item| *item == 0)
            .ok_or(REJECTED)?;
        entries.push(Entry {
            pid: entry.th32ProcessID,
            parent: entry.th32ParentProcessID,
            name: String::from_utf16(&entry.szExeFile[..length]).map_err(|_| REJECTED)?,
        });
        more = unsafe { Process32NextW(handle.0, &mut entry) } != 0;
    }
    if unsafe { windows_sys::Win32::Foundation::GetLastError() }
        != windows_sys::Win32::Foundation::ERROR_NO_MORE_FILES
    {
        return Err(REJECTED.into());
    }
    Ok(entries)
}

/// The actual interactive session must belong to this token's account; a
/// nonzero token session alone also describes scheduled/noninteractive tokens.
pub fn interactive(process: &Process) -> Result<(), String> {
    if process.elevated || session_owner(process.session)? != process.sid {
        return Err(REJECTED.into());
    }
    Ok(())
}

/// The active login owner of a retained process's session, independent of any
/// elevated token or request field. UAC may use a different administrator SID.
pub fn session_owner(session: u32) -> Result<String, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::LookupAccountNameW;
    use windows_sys::Win32::System::RemoteDesktop::{
        WTSActive, WTSConnectState, WTSDomainName, WTSFreeMemory, WTSQuerySessionInformationW,
        WTSUserName,
    };
    if session == 0 {
        return Err(REJECTED.into());
    }
    fn value(session: u32, kind: i32) -> Result<Vec<u8>, String> {
        let mut pointer = std::ptr::null_mut();
        let mut length = 0;
        if unsafe {
            WTSQuerySessionInformationW(
                std::ptr::null_mut(),
                session,
                kind,
                &mut pointer,
                &mut length,
            )
        } == 0
            || pointer.is_null()
        {
            return Err(REJECTED.into());
        }
        let bytes =
            unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), length as usize) }.to_vec();
        unsafe { WTSFreeMemory(pointer.cast()) };
        Ok(bytes)
    }
    let state = value(session, WTSConnectState)?;
    if state.len() != 4 || i32::from_ne_bytes(state.try_into().map_err(|_| REJECTED)?) != WTSActive
    {
        return Err(REJECTED.into());
    }
    fn string(bytes: Vec<u8>) -> Result<String, String> {
        if bytes.len() % 2 != 0 {
            return Err(REJECTED.into());
        }
        let wide: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|value| u16::from_ne_bytes([value[0], value[1]]))
            .collect();
        let end = wide.iter().position(|value| *value == 0).ok_or(REJECTED)?;
        String::from_utf16(&wide[..end]).map_err(|_| REJECTED.into())
    }
    let user = string(value(session, WTSUserName)?)?;
    let domain = string(value(session, WTSDomainName)?)?;
    if user.is_empty() {
        return Err(REJECTED.into());
    }
    let account = format!("{domain}\\{user}");
    let account: Vec<u16> = std::ffi::OsStr::new(&account)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let (mut length, mut domain_length, mut kind) = (0, 0, 0);
    unsafe {
        LookupAccountNameW(
            std::ptr::null(),
            account.as_ptr(),
            std::ptr::null_mut(),
            &mut length,
            std::ptr::null_mut(),
            &mut domain_length,
            &mut kind,
        )
    };
    let mut sid = vec![0_u8; length as usize];
    let mut domain = vec![0_u16; domain_length as usize];
    if sid.is_empty()
        || unsafe {
            LookupAccountNameW(
                std::ptr::null(),
                account.as_ptr(),
                sid.as_mut_ptr().cast(),
                &mut length,
                domain.as_mut_ptr(),
                &mut domain_length,
                &mut kind,
            )
        } == 0
    {
        return Err(REJECTED.into());
    }
    crate::sid_to_string(sid.as_mut_ptr().cast()).ok_or_else(|| REJECTED.into())
}

pub fn interactive_profile() -> Result<PathBuf, String> {
    use windows_sys::Win32::Foundation::HANDLE;
    #[link(name = "userenv")]
    extern "system" {
        fn GetUserProfileDirectoryW(token: HANDLE, path: *mut u16, size: *mut u32) -> i32;
    }
    let process = Process::open(std::process::id())?;
    interactive(&process)?;
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(process.handle.0, TOKEN_QUERY, &mut token) } == 0 {
        return Err(REJECTED.into());
    }
    let token = Owned(token);
    let mut size = 0;
    unsafe { GetUserProfileDirectoryW(token.0, std::ptr::null_mut(), &mut size) };
    if size == 0 || size > 32_768 {
        return Err(REJECTED.into());
    }
    let mut path = vec![0_u16; size as usize];
    if unsafe { GetUserProfileDirectoryW(token.0, path.as_mut_ptr(), &mut size) } == 0 {
        return Err(REJECTED.into());
    }
    let end = path.iter().position(|value| *value == 0).ok_or(REJECTED)?;
    let path = PathBuf::from(OsString::from_wide(&path[..end]));
    if !path.is_absolute() {
        return Err(REJECTED.into());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_zero_cannot_nominate_an_interactive_pairing_owner() {
        assert!(session_owner(0).is_err());
    }
    #[test]
    fn retained_kernel_identity_is_stable_and_unsigned_process_is_untrusted() {
        let own = Process::open(std::process::id()).unwrap();
        assert!(own.alive());
        assert_eq!(
            own.generation,
            Process::open(std::process::id()).unwrap().generation
        );
        assert!(own.signed(None).is_err());
        assert!(snapshot()
            .unwrap()
            .iter()
            .any(|entry| entry.pid == std::process::id()));
    }
}
