//! Kernel generation identities, independent of clocks, PID files and HOME.
use crate::protocol::NativeError;

fn refused() -> NativeError { NativeError::new("EXECUTOR_KERNEL_CONTEXT_UNAVAILABLE") }
pub fn valid_boot_id(value: &str) -> bool {
    value.len() == 36 && value.bytes().enumerate().all(|(index, byte)| {
        if [8, 13, 18, 23].contains(&index) { byte == b'-' }
        else { byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) }
    }) && value != "00000000-0000-0000-0000-000000000000"
}

#[cfg(target_os = "linux")]
pub fn boot_id() -> Result<String, NativeError> {
    let value = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").map_err(|_| refused())?;
    let value = value.trim();
    if !valid_boot_id(value) { return Err(refused()); }
    Ok(value.to_owned())
}

#[cfg(target_os = "macos")]
pub fn boot_id() -> Result<String, NativeError> {
    let mut bytes = [0_u8; 64];
    let mut size = bytes.len();
    if unsafe { libc::sysctlbyname(c"kern.bootsessionuuid".as_ptr(), bytes.as_mut_ptr().cast(),
        &mut size, std::ptr::null_mut(), 0) } != 0 || size == 0 || size > bytes.len() {
        return Err(refused());
    }
    let value = std::str::from_utf8(&bytes[..size]).map_err(|_| refused())?
        .trim_end_matches('\0').to_ascii_lowercase();
    if !valid_boot_id(&value) { return Err(refused()); }
    Ok(value)
}

#[cfg(windows)]
pub fn boot_id() -> Result<String, NativeError> {
    // SYSTEM_BOOT_ENVIRONMENT_INFORMATION, SystemBootEnvironmentInformation
    // (0x5a): the boot GUID remains stable through time changes and resume.
    #[repr(C)]
    struct BootEnvironment { identifier: windows_sys::core::GUID, firmware: u32, flags: u64 }
    #[link(name = "ntdll")]
    extern "system" {
        fn NtQuerySystemInformation(class: u32, information: *mut std::ffi::c_void,
            length: u32, returned: *mut u32) -> i32;
    }
    let mut value = std::mem::MaybeUninit::<BootEnvironment>::zeroed();
    let mut returned = 0;
    let size = std::mem::size_of::<BootEnvironment>() as u32;
    if unsafe { NtQuerySystemInformation(0x5a, value.as_mut_ptr().cast(), size, &mut returned) } != 0
        || returned != size { return Err(refused()); }
    let value = unsafe { value.assume_init() }.identifier;
    let id = format!("{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        value.data1, value.data2, value.data3, value.data4[0], value.data4[1], value.data4[2],
        value.data4[3], value.data4[4], value.data4[5], value.data4[6], value.data4[7]);
    if !valid_boot_id(&id) { return Err(refused()); }
    Ok(id)
}

#[cfg(target_os = "linux")]
pub fn birth(pid: i32) -> Result<String, NativeError> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).map_err(|_| refused())?;
    let end = stat.rfind(')').ok_or_else(refused)?;
    let start = stat[end + 1..].split_whitespace().nth(19).ok_or_else(refused)?;
    if start.is_empty() || !start.bytes().all(|byte| byte.is_ascii_digit()) { return Err(refused()); }
    Ok(start.to_owned())
}

#[cfg(target_os = "macos")]
pub fn birth(pid: i32) -> Result<String, NativeError> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    if pid <= 0 || unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0,
        info.as_mut_ptr().cast(), size) } != size { return Err(refused()); }
    let info = unsafe { info.assume_init() };
    if info.pbi_pid != pid as u32 { return Err(refused()); }
    started(&info)
}

/// The generation a full kernel record names, read from that same record so a
/// process that ends after it was read keeps the identity it was read with.
#[cfg(target_os = "macos")]
pub fn started(info: &libc::proc_bsdinfo) -> Result<String, NativeError> {
    if info.pbi_start_tvusec >= 1_000_000 || info.pbi_start_tvsec == 0 { return Err(refused()); }
    let micros = info.pbi_start_tvsec.checked_mul(1_000_000)
        .and_then(|value| value.checked_add(info.pbi_start_tvusec)).ok_or_else(refused)?;
    Ok(micros.to_string())
}

#[cfg(windows)]
pub fn birth(pid: i32) -> Result<String, NativeError> {
    use windows_sys::Win32::{Foundation::{CloseHandle, FILETIME}, System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION}};
    if pid <= 0 { return Err(refused()); }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32) };
    if process.is_null() { return Err(refused()); }
    let mut created = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let mut exited = created;
    let mut kernel = created;
    let mut user = created;
    let success = unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) };
    unsafe { CloseHandle(process) };
    if success == 0 { return Err(refused()); }
    let started = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
    if started == 0 { return Err(refused()); }
    Ok(started.to_string())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub fn boot_id() -> Result<String, NativeError> { Err(refused()) }
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub fn birth(_pid: i32) -> Result<String, NativeError> { Err(refused()) }

pub fn respond(pid: i32) -> Result<(), NativeError> {
    let boot = boot_id()?;
    let started = birth(pid)?;
    if boot_id()? != boot { return Err(refused()); }
    println!("{}", serde_json::json!({"version":1,"pid":pid,"bootId":boot,"startedAt":started}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_kernel_generation_is_stable_and_missing_process_refuses() {
        let boot = boot_id().unwrap();
        assert!(valid_boot_id(&boot));
        assert_eq!(boot_id().unwrap(), boot);
        let pid = std::process::id() as i32;
        let started = birth(pid).unwrap();
        assert!(!started.is_empty());
        assert_eq!(birth(pid).unwrap(), started);
        assert!(birth(i32::MAX).is_err());
        assert!(!valid_boot_id("00000000-0000-0000-0000-000000000000"));
    }
}
