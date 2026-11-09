//! Shared system SQLite reader. Fixed callers supply their own static read policy;
//! this connection exposes no transport, source selector or mutation authority.
use crate::custody::REJECTED;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    ffi::{c_char, c_int, c_void, CStr, CString},
    path::Path,
};
#[path = "readonly_sqlite_api.rs"]
mod api;
#[path = "readonly_sqlite_handles.rs"]
mod handles;
use api::{api, Api};
fn fail() -> String {
    REJECTED.into()
}
pub type Authorizer =
    unsafe extern "C" fn(*mut c_void, c_int, *const c_char, *const c_char, *const c_char, *const c_char) -> c_int;
pub struct Connection {
    api: &'static Api,
    raw: *mut c_void,
    statements: HashMap<u64, *mut c_void>,
    next: u64,
}
impl Connection {
    pub fn open(path: &Path, authorizer: Authorizer) -> Result<Self, String> {
        let api = api()?;
        let path = CString::new(path.to_str().ok_or_else(fail)?).map_err(|_| fail())?;
        let mut raw = std::ptr::null_mut();
        // READONLY | FULLMUTEX; no URI interpretation, CREATE or immutable mode.
        let code = unsafe { (api.sqlite3_open_v2)(path.as_ptr(), &mut raw, 1 | 0x10000, std::ptr::null()) };
        if code != 0 {
            if !raw.is_null() {
                unsafe {
                    (api.sqlite3_close_v2)(raw);
                }
            }
            return Err(fail());
        }
        let db = Self {
            api,
            raw,
            statements: HashMap::new(),
            next: 0,
        };
        if unsafe { (api.sqlite3_db_readonly)(raw, c"main".as_ptr()) } != 1 {
            return Err(fail());
        }
        unsafe {
            (api.sqlite3_busy_timeout)(raw, 250);
            (api.sqlite3_limit)(raw, 0, 8 * 1024 * 1024);
        }
        if unsafe { (api.sqlite3_set_authorizer)(raw, Some(authorizer), std::ptr::null_mut()) } != 0 {
            return Err(fail());
        }
        Ok(db)
    }
    pub fn prepare(&mut self, sql: &str) -> Result<u64, String> {
        if self.statements.len() >= 8 {
            return Err(fail());
        }
        let sql = CString::new(sql).map_err(|_| fail())?;
        let mut stmt = std::ptr::null_mut();
        if unsafe { (self.api.sqlite3_prepare_v2)(self.raw, sql.as_ptr(), -1, &mut stmt, std::ptr::null_mut()) } != 0 {
            if !stmt.is_null() {
                unsafe {
                    (self.api.sqlite3_finalize)(stmt);
                }
            }
            return Err(fail());
        }
        self.next = self.next.checked_add(1).ok_or_else(fail)?;
        self.statements.insert(self.next, stmt);
        Ok(self.next)
    }
    /// Fixed native callers only. Values are bound, never interpolated as SQL.
    /// Refuses an ambiguous multi-row result and always finalizes the statement.
    pub fn read_one(&mut self, sql: &str, values: &[&str]) -> Result<Option<Value>, String> {
        let id = self.prepare(sql)?;
        let result = (|| {
            let stmt = *self.statements.get(&id).ok_or_else(fail)?;
            if unsafe { (self.api.sqlite3_bind_parameter_count)(stmt) } != values.len() as c_int {
                return Err(fail());
            }
            for (index, value) in values.iter().enumerate() {
                let text = CString::new(*value).map_err(|_| fail())?;
                let length: c_int = text.as_bytes().len().try_into().map_err(|_| fail())?;
                // SQLite's documented SQLITE_TRANSIENT sentinel copies the
                // exact UTF-8 bytes before the temporary CString is dropped.
                let transient = unsafe { std::mem::transmute::<isize, Option<unsafe extern "C" fn(*mut c_void)>>(-1) };
                if unsafe { (self.api.sqlite3_bind_text)(stmt, (index + 1) as c_int, text.as_ptr(), length, transient) }
                    != 0
                {
                    return Err(fail());
                }
            }
            let first = self.next(id)?;
            if first["done"] == true {
                return Ok(None);
            }
            if self.next(id)?["done"] != true {
                return Err(fail());
            }
            Ok(Some(first["row"].clone()))
        })();
        self.finish(id)?;
        result
    }
    pub fn finish(&mut self, id: u64) -> Result<(), String> {
        let stmt = self.statements.remove(&id).ok_or_else(fail)?;
        if unsafe { (self.api.sqlite3_finalize)(stmt) } != 0 {
            return Err(fail());
        }
        Ok(())
    }
    pub fn next(&mut self, id: u64) -> Result<Value, String> {
        let stmt = *self.statements.get(&id).ok_or_else(fail)?;
        match unsafe { (self.api.sqlite3_step)(stmt) } {
            101 => return Ok(json!({"done":true})),
            100 => {}
            _ => return Err(fail()),
        }
        let mut row = serde_json::Map::new();
        let mut size = 0;
        for index in 0..unsafe { (self.api.sqlite3_column_count)(stmt) } {
            let name = unsafe { (self.api.sqlite3_column_name)(stmt, index) };
            if name.is_null() {
                return Err(fail());
            }
            let name = unsafe { CStr::from_ptr(name) }.to_str().map_err(|_| fail())?;
            let value = match unsafe { (self.api.sqlite3_column_type)(stmt, index) } {
                1 => {
                    let value = unsafe { (self.api.sqlite3_column_int64)(stmt, index) };
                    if !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&value) {
                        return Err(fail());
                    }
                    json!(value)
                }
                2 => {
                    let value = unsafe { (self.api.sqlite3_column_double)(stmt, index) };
                    if !value.is_finite() {
                        return Err(fail());
                    }
                    json!(value)
                }
                3 => {
                    let count = unsafe { (self.api.sqlite3_column_bytes)(stmt, index) };
                    if count < 0 {
                        return Err(fail());
                    }
                    size += count as usize;
                    if size > 8 * 1024 * 1024 {
                        return Err(fail());
                    }
                    let pointer = unsafe { (self.api.sqlite3_column_text)(stmt, index) };
                    if pointer.is_null() {
                        return Err(fail());
                    }
                    let bytes = unsafe { std::slice::from_raw_parts(pointer, count as usize) };
                    json!(std::str::from_utf8(bytes).map_err(|_| fail())?)
                }
                5 => Value::Null,
                _ => return Err(fail()),
            };
            row.insert(name.to_owned(), value);
        }
        Ok(json!({"row":row,"done":false}))
    }

    pub fn verify_files(&self, main: &str, wal: Option<&str>, owner: &str) -> Result<(), String> {
        handles::verify_main(self.api, self.raw, main, owner)?;
        if let Some(wal) = wal {
            handles::verify_wal(self.api, self.raw, wal, owner)?;
        }
        Ok(())
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        for (_, stmt) in self.statements.drain() {
            unsafe {
                (self.api.sqlite3_finalize)(stmt);
            }
        }
        unsafe {
            (self.api.sqlite3_close_v2)(self.raw);
        }
    }
}
