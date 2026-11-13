//! Load the OS SQLite from System32, never the working directory, application
//! directory or PATH. Refuse a preloaded same-name DLL from another location.
use crate::custody::REJECTED;
fn fail() -> String {
    REJECTED.into()
}
use std::{
    ffi::{c_char, c_int, c_void},
    sync::OnceLock,
};

#[link(name = "kernel32")]
extern "system" {
    fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    fn LoadLibraryExW(path: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
    fn GetModuleFileNameW(module: *mut c_void, buffer: *mut u16, size: u32) -> u32;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *const c_void;
}
fn system_library() -> Result<*mut c_void, String> {
    let mut buffer = vec![0_u16; 32768];
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 || length >= buffer.len() {
        return Err(fail());
    }
    let directory = String::from_utf16(&buffer[..length]).map_err(|_| fail())?;
    let expected = format!("{directory}\\winsqlite3.dll");
    let wide: Vec<u16> = expected.encode_utf16().chain(Some(0)).collect();
    let module = unsafe { LoadLibraryExW(wide.as_ptr(), std::ptr::null_mut(), 0x800) }; // SEARCH_SYSTEM32
    if module.is_null() {
        return Err(fail());
    }
    let length = unsafe { GetModuleFileNameW(module, buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 || length >= buffer.len() {
        return Err(fail());
    }
    let actual = String::from_utf16(&buffer[..length]).map_err(|_| fail())?;
    if !actual.eq_ignore_ascii_case(&expected) {
        return Err(fail());
    }
    // Retain this module for the process lifetime, covering every SQLite handle.
    Ok(module)
}
fn address(module: *mut c_void, name: &[u8]) -> Result<*const c_void, String> {
    let pointer = unsafe { GetProcAddress(module, name.as_ptr()) };
    if pointer.is_null() {
        Err(fail())
    } else {
        Ok(pointer)
    }
}
macro_rules! sqlite_api {
    ($(fn $name:ident($($parameter:ident: $argument:ty),*) -> $result:ty;)*) => {
        pub(super) struct Api { $(pub $name: unsafe extern "C" fn($($argument),*) -> $result,)* }
        fn load() -> Result<Api, String> {
            let module = system_library()?;
            Ok(Api { $($name: unsafe { std::mem::transmute::<*const c_void,
                unsafe extern "C" fn($($argument),*) -> $result>(
                    address(module, concat!(stringify!($name), "\0").as_bytes())?) },)* })
        }
    }
}
sqlite_api! {
    fn sqlite3_open_v2(name: *const c_char, db: *mut *mut c_void, flags: c_int, vfs: *const c_char) -> c_int;
    fn sqlite3_close_v2(db: *mut c_void) -> c_int;
    fn sqlite3_prepare_v2(db: *mut c_void, sql: *const c_char, size: c_int, stmt: *mut *mut c_void, tail: *mut *const c_char) -> c_int;
    fn sqlite3_step(stmt: *mut c_void) -> c_int;
    fn sqlite3_progress_handler(db: *mut c_void, instructions: c_int,
        callback: Option<unsafe extern "C" fn(*mut c_void) -> c_int>, data: *mut c_void) -> ();
    fn sqlite3_finalize(stmt: *mut c_void) -> c_int;
    fn sqlite3_bind_parameter_count(stmt: *mut c_void) -> c_int;
    fn sqlite3_bind_text(stmt: *mut c_void, index: c_int, text: *const c_char, length: c_int,
        destroy: Option<unsafe extern "C" fn(*mut c_void)>) -> c_int;
    fn sqlite3_column_count(stmt: *mut c_void) -> c_int;
    fn sqlite3_column_name(stmt: *mut c_void, index: c_int) -> *const c_char;
    fn sqlite3_column_type(stmt: *mut c_void, index: c_int) -> c_int;
    fn sqlite3_column_int64(stmt: *mut c_void, index: c_int) -> i64;
    fn sqlite3_column_double(stmt: *mut c_void, index: c_int) -> f64;
    fn sqlite3_column_text(stmt: *mut c_void, index: c_int) -> *const u8;
    fn sqlite3_column_bytes(stmt: *mut c_void, index: c_int) -> c_int;
    fn sqlite3_busy_timeout(db: *mut c_void, milliseconds: c_int) -> c_int;
    fn sqlite3_db_readonly(db: *mut c_void, schema: *const c_char) -> c_int;
    fn sqlite3_file_control(db: *mut c_void, schema: *const c_char, operation: c_int, argument: *mut c_void) -> c_int;
    fn sqlite3_limit(db: *mut c_void, category: c_int, value: c_int) -> c_int;
    fn sqlite3_set_authorizer(db: *mut c_void, callback: Option<unsafe extern "C" fn(*mut c_void,
        c_int, *const c_char, *const c_char, *const c_char, *const c_char) -> c_int>, data: *mut c_void) -> c_int;
}
pub(super) fn api() -> Result<&'static Api, String> {
    static API: OnceLock<Result<Api, ()>> = OnceLock::new();
    API.get_or_init(|| load().map_err(|_| ())).as_ref().map_err(|_| fail())
}
