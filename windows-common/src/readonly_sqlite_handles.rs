//! Public SQLite file-control ABI only: no WinFile/pager/private structure casts.
//! A system SQLite without these controls refuses before exposing source rows.
use super::api::Api;
use crate::{custody::REJECTED, execution_resource_handles::verify_file_handle};
fn fail() -> String {
    REJECTED.into()
}
use std::ffi::{c_int, c_void};
use windows_sys::Win32::Foundation::HANDLE;

#[repr(C)]
struct SqliteFile {
    methods: *const IoMethods,
}
// The stable version-one prefix of public sqlite3_io_methods. No later fields
// are read and only xFileControl is called; all other operations stay in SQLite.
#[repr(C)]
struct IoMethods {
    version: c_int,
    close: Option<unsafe extern "C" fn(*mut SqliteFile) -> c_int>,
    read: Option<unsafe extern "C" fn(*mut SqliteFile, *mut c_void, c_int, i64) -> c_int>,
    write: Option<unsafe extern "C" fn(*mut SqliteFile, *const c_void, c_int, i64) -> c_int>,
    truncate: Option<unsafe extern "C" fn(*mut SqliteFile, i64) -> c_int>,
    sync: Option<unsafe extern "C" fn(*mut SqliteFile, c_int) -> c_int>,
    size: Option<unsafe extern "C" fn(*mut SqliteFile, *mut i64) -> c_int>,
    lock: Option<unsafe extern "C" fn(*mut SqliteFile, c_int) -> c_int>,
    unlock: Option<unsafe extern "C" fn(*mut SqliteFile, c_int) -> c_int>,
    reserved: Option<unsafe extern "C" fn(*mut SqliteFile, *mut c_int) -> c_int>,
    control: Option<unsafe extern "C" fn(*mut SqliteFile, c_int, *mut c_void) -> c_int>,
}
const JOURNAL_POINTER: c_int = 28;
const WIN32_GET_HANDLE: c_int = 29;

pub fn verify_main(api: &Api, database: *mut c_void, expected: &str, owner: &str) -> Result<(), String> {
    let mut handle: HANDLE = std::ptr::null_mut();
    if unsafe {
        (api.sqlite3_file_control)(
            database,
            c"main".as_ptr(),
            WIN32_GET_HANDLE,
            (&mut handle as *mut HANDLE).cast(),
        )
    } != 0
    {
        return Err(fail());
    }
    verify(handle, expected, owner)
}
pub fn verify_wal(api: &Api, database: *mut c_void, expected: &str, owner: &str) -> Result<(), String> {
    let mut file: *mut SqliteFile = std::ptr::null_mut();
    if unsafe {
        (api.sqlite3_file_control)(
            database,
            c"main".as_ptr(),
            JOURNAL_POINTER,
            (&mut file as *mut *mut SqliteFile).cast(),
        )
    } != 0
        || file.is_null()
    {
        return Err(fail());
    }
    let methods = unsafe { (*file).methods };
    if methods.is_null() || unsafe { (*methods).version } < 1 {
        return Err(fail());
    }
    let control = unsafe { (*methods).control }.ok_or_else(fail)?;
    let mut handle: HANDLE = std::ptr::null_mut();
    if unsafe { control(file, WIN32_GET_HANDLE, (&mut handle as *mut HANDLE).cast()) } != 0 {
        return Err(fail());
    }
    verify(handle, expected, owner)
}
fn verify(handle: HANDLE, expected: &str, owner: &str) -> Result<(), String> {
    verify_file_handle(handle, expected, owner)
}
