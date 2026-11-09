//! Kernel-only absence and Job Object observations; these never mutate custody.
use crate::{custody::REJECTED, process::{self, Owned}};
use std::os::windows::ffi::OsStrExt;
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_INVALID_PARAMETER},
    System::JobObjects::{OpenJobObjectW, QueryInformationJobObject, JobObjectBasicProcessIdList,
        JOBOBJECT_BASIC_PROCESS_ID_LIST},
};
const JOB_OBJECT_QUERY: u32 = 0x0004;
pub fn job_members(name: &str) -> Result<Vec<u32>, String> {
    let name: Vec<u16> = std::ffi::OsStr::new(name)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let handle = unsafe { OpenJobObjectW(JOB_OBJECT_QUERY, 0, name.as_ptr()) };
    if handle.is_null() {
        return if unsafe { GetLastError() } == ERROR_FILE_NOT_FOUND {
            Ok(Vec::new())
        } else {
            Err(REJECTED.into())
        };
    }
    let job = Owned(handle);
    let mut buffer = vec![0_usize; 4098];
    let mut returned = 0;
    if unsafe {
        QueryInformationJobObject(
            job.0,
            JobObjectBasicProcessIdList,
            buffer.as_mut_ptr().cast(),
            (buffer.len() * std::mem::size_of::<usize>()) as u32,
            &mut returned,
        )
    } == 0
    {
        return Err(REJECTED.into());
    }
    let list = unsafe { &*buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
    if list.NumberOfAssignedProcesses != list.NumberOfProcessIdsInList
        || list.NumberOfProcessIdsInList > 4096
    {
        return Err(REJECTED.into());
    }
    let ids = unsafe {
        std::slice::from_raw_parts(
            list.ProcessIdList.as_ptr(),
            list.NumberOfProcessIdsInList as usize,
        )
    };
    let mut members: Vec<u32> = ids
        .iter()
        .map(|id| u32::try_from(*id).map_err(|_| String::from(REJECTED)))
        .collect::<Result<_, _>>()?;
    members.sort_unstable();
    Ok(members)
}
/// Whether the recorded kernel generation has ended.
///
/// Every generation custody records granted this observer query and
/// synchronize access before it was recorded: the native helper grants the
/// service account on itself before each service call, and on its suspended
/// child before registering it. A running process keeps that grant, so a PID
/// this observer is denied belongs to a different process that reused it. On
/// Minis a dead lease controller's PID taken by an unrelated `node_repl`
/// refused every Nessie Computer launch until that process exited.
pub fn absent(generation: &crate::custody::Generation) -> Result<bool, String> {
    if generation.boot_id != process::boot_id()? {
        return Ok(true);
    }
    use windows_sys::Win32::{
        Foundation::{FILETIME, WAIT_OBJECT_0},
        System::Threading::{
            GetProcessTimes, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE,
        },
    };
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            generation.pid,
        )
    };
    if handle.is_null() {
        return match unsafe { GetLastError() } {
            ERROR_INVALID_PARAMETER | ERROR_ACCESS_DENIED => Ok(true),
            _ => Err(REJECTED.into()),
        };
    }
    let handle = Owned(handle);
    if unsafe { WaitForSingleObject(handle.0, 0) } == WAIT_OBJECT_0 {
        return Ok(true);
    }
    let mut times = [FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    }; 4];
    let [created, exited, kernel, user] = &mut times;
    if unsafe { GetProcessTimes(handle.0, created, exited, kernel, user) } == 0 {
        return Err(REJECTED.into());
    }
    Ok(
        (((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64).to_string()
            != generation.started_at,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absence_is_bound_to_the_kernel_generation_and_boot() {
        let current = process::Process::open(std::process::id()).unwrap();
        assert!(!absent(&current.generation).unwrap());
        let mut replaced = current.generation.clone();
        replaced.started_at = "0".into();
        assert!(absent(&replaced).unwrap());
        replaced = current.generation.clone();
        replaced.boot_id = "00000000-0000-0000-0000-000000000000".into();
        assert!(absent(&replaced).unwrap());
    }
    /// A live process with an empty DACL, observed without privileges, is what
    /// an unrelated process that reused a recorded PID looks like to the
    /// service account. An elevated test host's enabled debug privilege would
    /// open it anyway, so the observation runs under a restricted copy of this
    /// process's token with every privilege removed.
    #[test]
    fn a_pid_this_observer_is_denied_is_not_the_recorded_generation() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::{CloseHandle, LocalFree},
            Security::{
                Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
                CreateRestrictedToken, ImpersonateLoggedOnUser, RevertToSelf,
                SetKernelObjectSecurity, DACL_SECURITY_INFORMATION, DISABLE_MAX_PRIVILEGE,
                TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_IMPERSONATE, TOKEN_QUERY,
            },
            System::Threading::{GetCurrentProcess, OpenProcessToken},
        };
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "ping -n 30 127.0.0.1 >nul"])
            .spawn()
            .unwrap();
        let recorded = process::Process::open(child.id()).unwrap().generation;
        let text: Vec<u16> = "D:P".encode_utf16().chain(Some(0)).collect();
        let mut descriptor = std::ptr::null_mut();
        assert_ne!(unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text.as_ptr(), 1, &mut descriptor, std::ptr::null_mut()) }, 0);
        let denied = unsafe { SetKernelObjectSecurity(
            child.as_raw_handle(), DACL_SECURITY_INFORMATION, descriptor) };
        unsafe { LocalFree(descriptor) };
        assert_ne!(denied, 0);
        let (mut own, mut restricted) = (std::ptr::null_mut(), std::ptr::null_mut());
        assert_ne!(unsafe { OpenProcessToken(GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_IMPERSONATE, &mut own) }, 0);
        assert_ne!(unsafe { CreateRestrictedToken(own, DISABLE_MAX_PRIVILEGE, 0, std::ptr::null(),
            0, std::ptr::null(), 0, std::ptr::null(), &mut restricted) }, 0);
        // A HANDLE is a raw pointer; the impersonating thread gets its value.
        let token = restricted as usize;
        let observed = std::thread::scope(|scope| scope.spawn(|| {
            assert_ne!(unsafe { ImpersonateLoggedOnUser(token as _) }, 0);
            let observed = absent(&recorded);
            unsafe { RevertToSelf() };
            observed
        }).join().unwrap());
        unsafe { CloseHandle(restricted); CloseHandle(own) };
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(observed, Ok(true));
    }

    #[test]
    fn an_absent_named_job_has_no_retained_descendants() {
        let name = format!("Global\\NessieCustody-test-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        assert!(job_members(&name).unwrap().is_empty());
    }
}
