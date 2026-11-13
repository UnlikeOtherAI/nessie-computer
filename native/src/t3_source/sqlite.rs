//! Windows' supported system SQLite owns the source connection for the lease.
//! No ATTACH, extension loading, arbitrary SQL or original server setup layer.
use super::handles::fail;
use crate::protocol::NativeError;
use serde_json::{json, Value};
use std::{ffi::{c_char, c_int, c_void, CStr}, path::Path};

use nessie_windows_common::readonly_sqlite::Connection;

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

pub struct Database { connection: Connection, owner: String, v2: bool }
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
        self.connection.verify_files(main, wal, &self.owner).map_err(|_| fail())
    }
    pub fn open(path: &Path, v2: bool) -> Result<Self, NativeError> {
        let owner = nessie_windows_common::process::Process::open(std::process::id()).map_err(|_| fail())?.sid;
        Ok(Self { connection: Connection::open(path, authorize).map_err(|_| fail())?, owner, v2 })
    }
    fn prepare(&mut self, sql: &str) -> Result<u64, NativeError> { self.connection.prepare(sql).map_err(|_| fail()) }
    pub fn finish(&mut self, id: u64) -> Result<(), NativeError> { self.connection.finish(id).map_err(|_| fail()) }
    pub fn next(&mut self, id: u64) -> Result<Value, NativeError> { self.connection.next(id).map_err(|_| fail()) }
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
