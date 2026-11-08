//! Windows' supported system SQLite owns the source connection for the lease.
//! No ATTACH, extension loading, arbitrary SQL or original server setup layer.
use super::handles::fail;
use crate::protocol::NativeError;
use serde_json::{json, Value};
use std::{collections::HashMap, ffi::{c_char, c_int, c_void, CStr, CString}, path::Path};

use super::sqlite_api::{api, Api};

unsafe extern "C" fn authorize(_: *mut c_void, action: c_int, first: *const c_char,
    second: *const c_char, _: *const c_char, _: *const c_char) -> c_int {
    let string = |pointer| if pointer == std::ptr::null() { "" }
        else { CStr::from_ptr(pointer).to_str().unwrap_or("") };
    let table = string(first); let column = string(second);
    let allowed = match action {
        21 | 22 => true, // SELECT and transaction control, never INSERT/ATTACH/DDL.
        31 => ["max", "coalesce", "pragma_table_info", "pragma_schema_version"].contains(&column),
        19 => ["table_info", "schema_version"].contains(&table),
        20 => {
            static TABLES: std::sync::OnceLock<Vec<Value>> = std::sync::OnceLock::new();
            let tables = TABLES.get_or_init(|| serde_json::from_str(
                include_str!("../../../src/t3-session/source/tables.json")).expect("committed source table catalogue"));
            match table {
                "sqlite_master" | "sqlite_schema" => ["name", "type", "sql", "rootpage", "tbl_name"].contains(&column),
                "effect_sql_migrations" => ["migration_id", "name"].contains(&column),
                "pragma_table_info" => column == "name",
                "pragma_schema_version" => column == "schema_version",
                _ => tables.iter().any(|entry| entry["name"] == table && (column.is_empty()
                    || entry["columns"].as_array().is_some_and(|columns| columns.iter().any(|value| value == column))
                    || table == "projection_projects" && ["pinned_at", "archived_at"].contains(&column))),
            }
        },
        _ => false,
    };
    if allowed { 0 } else { 1 }
}

pub struct Database { api: &'static Api, raw: *mut c_void, statements: HashMap<u64, *mut c_void>, next: u64, v2: bool }
impl Database {
    /// Shared fixed-read wire; neither resource lane accepts caller SQL.
    pub(super) fn dispatch_read(&mut self, request: &Value) -> Result<Value, NativeError> {
        let fields = request.as_object().ok_or_else(fail)?;
        match request["op"].as_str().ok_or_else(fail)? {
            "query" => {
                if fields.keys().any(|key| !["op", "query", "table"].contains(&key.as_str()))
                    || fields.contains_key("table") && !request["table"].is_string() { return Err(fail()); }
                self.query(request["query"].as_str().ok_or_else(fail)?, request["table"].as_str())
            },
            "next" | "finalize" => {
                if fields.len() != 2 { return Err(fail()); }
                let id = request["statement"].as_u64().ok_or_else(fail)?;
                if request["op"] == "next" { self.next(id) }
                else { self.finish(id)?; Ok(json!({})) }
            },
            _ => Err(fail()),
        }
    }
    pub fn verify_files(&self, main: &str, wal: Option<&str>) -> Result<(), NativeError> {
        super::sqlite_handles::verify_main(self.api, self.raw, main)?;
        if let Some(wal) = wal { super::sqlite_handles::verify_wal(self.api, self.raw, wal)?; }
        Ok(())
    }
    pub fn open(path: &Path, v2: bool) -> Result<Self, NativeError> {
        let api = api()?;
        let path = CString::new(path.to_str().ok_or_else(fail)?).map_err(|_| fail())?;
        let mut raw = std::ptr::null_mut();
        // READONLY | FULLMUTEX; no URI interpretation, CREATE or immutable mode.
        let code = unsafe { (api.sqlite3_open_v2)(path.as_ptr(), &mut raw, 1 | 0x10000, std::ptr::null()) };
        if code != 0 {
            if !raw.is_null() { unsafe { (api.sqlite3_close_v2)(raw); } }
            return Err(fail());
        }
        let db = Self { api, raw, statements: HashMap::new(), next: 0, v2 };
        if unsafe { (api.sqlite3_db_readonly)(raw, c"main".as_ptr()) } != 1 { return Err(fail()); }
        unsafe { (api.sqlite3_busy_timeout)(raw, 250); (api.sqlite3_limit)(raw, 0, 8 * 1024 * 1024); }
        if unsafe { (api.sqlite3_set_authorizer)(raw, Some(authorize), std::ptr::null_mut()) } != 0 { return Err(fail()); }
        Ok(db)
    }
    fn prepare(&mut self, sql: &str) -> Result<u64, NativeError> {
        if self.statements.len() >= 8 { return Err(fail()); }
        let sql = CString::new(sql).map_err(|_| fail())?;
        let mut stmt = std::ptr::null_mut();
        if unsafe { (self.api.sqlite3_prepare_v2)(self.raw, sql.as_ptr(), -1, &mut stmt, std::ptr::null_mut()) } != 0 {
            if !stmt.is_null() { unsafe { (self.api.sqlite3_finalize)(stmt); } }
            return Err(fail());
        }
        self.next = self.next.checked_add(1).ok_or_else(fail)?;
        self.statements.insert(self.next, stmt);
        Ok(self.next)
    }
    pub fn finish(&mut self, id: u64) -> Result<(), NativeError> {
        let stmt = self.statements.remove(&id).ok_or_else(fail)?;
        if unsafe { (self.api.sqlite3_finalize)(stmt) } != 0 { return Err(fail()); }
        Ok(())
    }
    pub fn next(&mut self, id: u64) -> Result<Value, NativeError> {
        let stmt = *self.statements.get(&id).ok_or_else(fail)?;
        match unsafe { (self.api.sqlite3_step)(stmt) } {
            101 => return Ok(json!({"done":true})), 100 => {}, _ => return Err(fail()),
        }
        let mut row = serde_json::Map::new();
        let mut size = 0;
        for index in 0..unsafe { (self.api.sqlite3_column_count)(stmt) } {
            let name = unsafe { (self.api.sqlite3_column_name)(stmt, index) };
            if name.is_null() { return Err(fail()); }
            let name = unsafe { CStr::from_ptr(name) }.to_str().map_err(|_| fail())?;
            let value = match unsafe { (self.api.sqlite3_column_type)(stmt, index) } {
                1 => { let value = unsafe { (self.api.sqlite3_column_int64)(stmt, index) };
                    if !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&value) { return Err(fail()); }
                    json!(value) },
                2 => { let value = unsafe { (self.api.sqlite3_column_double)(stmt, index) };
                    if !value.is_finite() { return Err(fail()); } json!(value) },
                3 => {
                    let count = unsafe { (self.api.sqlite3_column_bytes)(stmt, index) };
                    if count < 0 { return Err(fail()); }
                    size += count as usize;
                    if size > 8 * 1024 * 1024 { return Err(fail()); }
                    let pointer = unsafe { (self.api.sqlite3_column_text)(stmt, index) };
                    if pointer.is_null() { return Err(fail()); }
                    let bytes = unsafe { std::slice::from_raw_parts(pointer, count as usize) };
                    json!(std::str::from_utf8(bytes).map_err(|_| fail())?)
                },
                5 => Value::Null, _ => return Err(fail()),
            };
            row.insert(name.to_owned(), value);
        }
        Ok(json!({"row":row,"done":false}))
    }
    pub fn transaction(&mut self, action: &str) -> Result<Value, NativeError> {
        if !["BEGIN", "COMMIT", "ROLLBACK"].contains(&action) { return Err(fail()); }
        let id = self.prepare(action)?;
        let result = self.next(id);
        self.finish(id)?;
        result
    }
    pub fn query(&mut self, query: &str, table: Option<&str>) -> Result<Value, NativeError> {
        let definitions: Vec<Value> = serde_json::from_str(include_str!("../../../src/t3-session/source/tables.json"))
            .map_err(|_| fail())?;
        let entry = table.and_then(|name| definitions.iter().find(|entry| entry["name"] == name));
        let sql = match query {
            "schemaVersion" => "PRAGMA schema_version".to_owned(),
            "migrationTable" => "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'effect_sql_migrations'".to_owned(),
            "migrations" => "SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id".to_owned(),
            "highWater" if self.v2 => "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events".to_owned(),
            "rows" | "frozenLegacy" | "columns" | "tableSchema" => {
                let entry = entry.ok_or_else(fail)?;
                let name = entry["name"].as_str().ok_or_else(fail)?;
                if !self.v2 && !definitions[..4].iter().any(|item| item["name"] == name) { return Err(fail()); }
                if query == "frozenLegacy" && (!self.v2 || !definitions[..3].iter().any(|item| item["name"] == name)) {
                    return Err(fail());
                }
                match query {
                    "columns" => format!("SELECT name FROM pragma_table_info('{name}')"),
                    "tableSchema" => format!("SELECT type, sql FROM sqlite_schema WHERE name = '{name}'"),
                    _ => {
                        // Refuse virtual tables/views before any row evaluation.
                        let schema = self.prepare(&format!("SELECT type, sql FROM sqlite_schema WHERE name = '{name}'"))?;
                        let row = self.next(schema)?;
                        self.finish(schema)?;
                        if row["row"]["type"] != "table" || !row["row"]["sql"].as_str()
                            .is_some_and(ordinary_table) { return Err(fail()); }
                        let mut columns = entry["columns"].as_array().ok_or_else(fail)?.iter()
                            .map(|column| column.as_str().ok_or_else(fail)).collect::<Result<Vec<_>, _>>()?;
                        if self.v2 && name == "projection_projects" { columns.extend(["pinned_at", "archived_at"]); }
                        let filter = if self.v2 && query != "frozenLegacy" && definitions[..3].iter().any(|item| item["name"] == name) {
                            " WHERE thread_id IN (SELECT thread_id FROM projection_threads AS legacy WHERE\n  NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads AS current WHERE current.thread_id = legacy.thread_id)\n  OR EXISTS (SELECT 1 FROM orchestration_v2_legacy_imports AS imported WHERE imported.thread_id = legacy.thread_id))".to_owned()
                        } else { entry["where"].as_str().map(|s| format!(" WHERE {s}")).unwrap_or_default() };
                        format!("SELECT {} FROM {name}{filter} ORDER BY {}", columns.join(", "), entry["order"].as_str().ok_or_else(fail)?)
                    }
                }
            },
            _ => return Err(fail()),
        };
        Ok(json!({"statement":self.prepare(&sql)?}))
    }
}
fn ordinary_table(sql: &str) -> bool {
    sql.get(..12).is_some_and(|prefix| prefix.eq_ignore_ascii_case("CREATE TABLE"))
        && sql.get(12..).and_then(|rest| rest.chars().next()).is_some_and(char::is_whitespace)
}
impl Drop for Database {
    fn drop(&mut self) {
        for (_, stmt) in self.statements.drain() { unsafe { (self.api.sqlite3_finalize)(stmt); } }
        unsafe { (self.api.sqlite3_close_v2)(self.raw); }
    }
}
