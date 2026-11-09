//! Actual independent readonly snapshot of the original projection input rows.
use nessie_windows_common::{
    custody::REJECTED,
    execution::now_ms,
    execution_recovery_inputs::{self as facts, Observation},
    execution_resource_handles::HeldObject,
    readonly_sqlite::Connection,
};
use std::ffi::{c_char, c_int, c_void, CStr};

unsafe extern "C" fn authorize(
    _: *mut c_void,
    action: c_int,
    first: *const c_char,
    second: *const c_char,
    _: *const c_char,
    _: *const c_char,
) -> c_int {
    let value = |p| {
        if p == std::ptr::null() {
            ""
        } else {
            CStr::from_ptr(p).to_str().unwrap_or("")
        }
    };
    let table = value(first);
    let column = value(second);
    let allowed = match action {
        21 | 22 => true,
        20 => {
            facts::TABLES.contains(&table)
                || matches!(table, "sqlite_schema" | "sqlite_master")
                    && ["name", "type", "sql"].contains(&column)
        }
        31 => [
            "json_valid",
            "json_type",
            "json_extract",
            "json_array_length",
            "coalesce",
        ]
        .contains(&column),
        _ => false,
    };
    if allowed {
        0
    } else {
        1
    }
}
fn query_rows(
    connection: &mut Connection,
    query: &str,
    parameters: &[&str],
    mut use_row: impl FnMut(serde_json::Value) -> Result<(), String>,
) -> Result<(), String> {
    let statement = connection.prepare(query)?;
    let work = (|| {
        connection.bind_texts(statement, parameters)?;
        loop {
            let value = connection.next(statement)?;
            if value["done"] == true {
                return Ok(());
            }
            if value["done"] != false {
                return Err(REJECTED.into());
            }
            use_row(value["row"].clone())?;
        }
    })();
    connection.finish(statement)?;
    work
}
pub(super) struct ProjectionRead {
    pub observation: Observation,
    pub thread_payload: String,
    pub rows: Vec<(String, String)>,
}
pub(super) fn schema(connection: &mut Connection) -> Result<(), String> {
    for table in facts::TABLES {
        let row = connection
            .read_one(
                "SELECT type, sql FROM sqlite_schema WHERE name = ?",
                &[table],
            )?
            .ok_or(REJECTED)?;
        if row["type"] != "table"
            || !row["sql"]
                .as_str()
                .is_some_and(|sql| sql.starts_with("CREATE TABLE"))
        {
            return Err(REJECTED.into());
        }
    }
    Ok(())
}
pub(super) fn read_projection(
    connection: &mut Connection,
    thread: &str,
    now: u64,
    until: std::time::Instant,
) -> Result<ProjectionRead, String> {
    // Callers own the wall-clock window. The shared reader always bounds actual
    // VM work with this monotonic deadline, including its fixed-time fixtures.
    let current = || std::time::Instant::now() < until;
    if !current() {
        return Err(REJECTED.into());
    }
    let queries = facts::queries()?;
    connection.set_deadline(until);
    schema(connection)?;
    let header = connection
        .read_one(&queries.thread.query, &[thread])?
        .ok_or(REJECTED)?;
    let payload = header["payload_json"].as_str().ok_or(REJECTED)?;
    if payload.len() > facts::MAX_BYTES {
        return Err(REJECTED.into());
    }
    let mut rows = Vec::new();
    let mut bytes = payload.len();
    for query in queries.sections {
        let params = vec![thread; query.parameters];
        query_rows(connection, &query.query, &params, |row| {
            let payload = row["payload_json"].as_str().ok_or(REJECTED)?;
            bytes = bytes.checked_add(payload.len()).ok_or(REJECTED)?;
            if rows.len() >= facts::MAX_ROWS || bytes > facts::MAX_BYTES || !current() {
                return Err(REJECTED.into());
            }
            rows.push((query.section.clone(), payload.into()));
            Ok(())
        })?;
    }
    if !current() {
        return Err(REJECTED.into());
    }
    Ok(ProjectionRead {
        observation: facts::observe(thread, payload, &rows, now)?,
        thread_payload: payload.into(),
        rows,
    })
}
pub(super) fn read(main: &HeldObject, owner: &str, thread: &str) -> Result<Observation, String> {
    let now = now_ms()?;
    let until = std::time::Instant::now() + std::time::Duration::from_millis(5000);
    let current = || {
        std::time::Instant::now() < until
            && now_ms().is_ok_and(|value| value < now.saturating_add(5000))
    };
    let observation =
        super::read::snapshot_with_authorizer(main, owner, authorize, |connection| {
            if !current() {
                return Err(REJECTED.into());
            }
            read_projection(connection, thread, now, until).map(|value| value.observation)
        })?;
    if !current() {
        return Err(REJECTED.into());
    }
    Ok(observation)
}
