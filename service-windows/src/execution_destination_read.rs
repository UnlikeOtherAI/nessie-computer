//! Independent pending-row facts from the service-held destination. No signer,
//! original-parent assertion, admission consumer or SQL mutation exists here.
use nessie_windows_common::{
    custody::REJECTED,
    execution::now_ms,
    execution_pending_effect::{self as facts, Observation, RECEIPT_COLUMNS, ROW_COLUMNS},
    execution_resource_handles::HeldObject,
    readonly_sqlite::Connection,
    readonly_sqlite_files::FileSnapshot,
};
use serde_json::Value;
use std::ffi::{c_char, c_int, c_void, CStr};
#[cfg(test)]
#[path = "execution_destination_read_tests.rs"]
mod tests;

unsafe extern "C" fn authorize(
    _: *mut c_void,
    action: c_int,
    first: *const c_char,
    second: *const c_char,
    _: *const c_char,
    _: *const c_char,
) -> c_int {
    let string = |p| {
        if p == std::ptr::null() {
            ""
        } else {
            CStr::from_ptr(p).to_str().unwrap_or("")
        }
    };
    let table = string(first);
    let column = string(second);
    let allowed = match action {
        21 | 22 => true, // SELECT and the reader's fixed BEGIN/COMMIT only.
        31 => column == "pragma_table_info",
        19 => table == "table_info",
        20 => match table {
            "sqlite_master" | "sqlite_schema" => ["name", "type", "sql"].contains(&column),
            "pragma_table_info" => ["name", "cid"].contains(&column),
            "orchestration_v2_effect_outbox" => ROW_COLUMNS.contains(&column),
            "orchestration_command_receipts" => RECEIPT_COLUMNS.contains(&column),
            _ => false,
        },
        _ => false,
    };
    if allowed {
        0
    } else {
        1
    }
}
fn schema(connection: &mut Connection, table: &str, columns: &[&str]) -> Result<(), String> {
    let value = connection
        .read_one("SELECT type, sql FROM sqlite_schema WHERE name = ?", &[table])?
        .ok_or(REJECTED)?;
    let sql = value["sql"].as_str().ok_or(REJECTED)?;
    if value["type"] != "table"
        || !sql.get(..12).is_some_and(|s| s.eq_ignore_ascii_case("CREATE TABLE"))
        || !sql
            .get(12..)
            .and_then(|s| s.chars().next())
            .is_some_and(char::is_whitespace)
    {
        return Err(REJECTED.into());
    }
    let query = match table {
        "orchestration_v2_effect_outbox" => {
            "SELECT name FROM pragma_table_info('orchestration_v2_effect_outbox') ORDER BY cid"
        }
        "orchestration_command_receipts" => {
            "SELECT name FROM pragma_table_info('orchestration_command_receipts') ORDER BY cid"
        }
        _ => return Err(REJECTED.into()),
    };
    let statement = connection.prepare(query)?;
    let result = (|| {
        for expected in columns {
            let value = connection.next(statement)?;
            if value["done"] != false || value["row"]["name"] != *expected {
                return Err(REJECTED.into());
            }
        }
        if connection.next(statement)?["done"] != true {
            return Err(REJECTED.into());
        }
        Ok(())
    })();
    connection.finish(statement)?;
    result
}
/// Called with the owning resource lock held. SQLite's own transaction provides
/// one row/receipt view; the VFS handles are checked before any facts escape.
pub(super) fn observe(
    main: &HeldObject,
    owner: &str,
    thread: &str,
    effect: &str,
) -> Result<Option<Observation>, String> {
    let observed_at_ms = now_ms()?;
    let files = FileSnapshot::open(main, owner)?;
    let mut connection = Connection::open(files.path(), authorize)?;
    connection.read_one("BEGIN", &[])?;
    schema(&mut connection, "orchestration_v2_effect_outbox", ROW_COLUMNS)?;
    schema(&mut connection, "orchestration_command_receipts", RECEIPT_COLUMNS)?;
    files.verify(&connection)?;
    let row: Option<Value> = connection.read_one(
        "SELECT * FROM orchestration_v2_effect_outbox
        WHERE effect_id = ? AND thread_id = ? AND status = 'pending'",
        &[effect, thread],
    )?;
    let observation = if let Some(row) = row {
        let command = row["command_id"].as_str().ok_or(REJECTED)?;
        let receipt = connection.read_one(
            "SELECT * FROM orchestration_command_receipts WHERE command_id = ?
            AND aggregate_kind = 'thread' AND aggregate_id = ? AND status = 'accepted' AND error IS NULL",
            &[command, thread],
        )?;
        receipt
            .map(|receipt| facts::observe(row, receipt, thread, effect, observed_at_ms))
            .transpose()?
    } else {
        None
    };
    files.verify(&connection)?;
    connection.read_one("COMMIT", &[])?;
    files.recheck()?;
    Ok(observation)
}
