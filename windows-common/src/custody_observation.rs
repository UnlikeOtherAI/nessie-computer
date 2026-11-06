//! Kernel-only absence and Job Object observations; these never mutate custody.
use crate::{custody::REJECTED, process::{self, Owned}};
use std::os::windows::ffi::OsStrExt;
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_FILE_NOT_FOUND, ERROR_INVALID_PARAMETER},
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
        return if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
            Ok(true)
        } else {
            Err(REJECTED.into())
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
    #[test]
    fn an_absent_named_job_has_no_retained_descendants() {
        let name = format!("Global\\NessieCustody-test-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        assert!(job_members(&name).unwrap().is_empty());
    }
}
