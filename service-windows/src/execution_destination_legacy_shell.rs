//! Independent fixed reads of the complete original shell plan. No SQL writes,
//! signatures, lifecycle permission, caller SQL or caller target list.
use nessie_windows_common::{
    custody::REJECTED,
    execution::{canonical, now_ms},
    execution_json,
    execution_legacy_shell::{self as facts, Observation, Target, MAX_BYTES, MAX_TARGETS},
    execution_resource_handles::HeldObject,
    readonly_sqlite::Connection,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    ffi::{c_char, c_int, c_void, CStr},
    time::{Duration, Instant},
};
#[path = "execution_legacy_shell_sql.rs"]
mod original;

pub(super) unsafe extern "C" fn authorize(
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
    let allowed = match action {
        21 | 22 => true, // SELECT and this fixed reader's BEGIN/COMMIT.
        31 => [
            "json_type",
            "json_group_array",
            "json_object",
            "json",
            "count",
            "like",
            "pragma_foreign_key_list",
        ]
        .contains(&string(second)),
        19 => table == "foreign_key_list",
        20 => [
            "sqlite_schema",
            "sqlite_master",
            "pragma_foreign_key_list",
            "projection_threads",
            "projection_thread_messages",
            "projection_thread_pull_requests",
            "orchestration_events",
            "orchestration_v2_legacy_imports",
            "orchestration_v2_projection_threads",
            "orchestration_v2_turn_item_positions",
        ]
        .contains(&table),
        _ => false,
    };
    if allowed {
        0
    } else {
        1
    }
}
struct ReadWindow {
    deadline: Instant,
    bytes: usize,
}
impl ReadWindow {
    fn check(&self) -> Result<(), String> {
        if Instant::now() >= self.deadline {
            return Err(REJECTED.into());
        }
        Ok(())
    }
    fn rows(
        &mut self,
        connection: &mut Connection,
        query: &str,
        max: usize,
    ) -> Result<Vec<Value>, String> {
        self.check()?;
        let statement = connection.prepare(query)?;
        let result = (|| {
            let mut rows = Vec::new();
            loop {
                self.check()?;
                let next = connection.next(statement)?;
                if next["done"] == true {
                    break;
                }
                if rows.len() >= max {
                    return Err(REJECTED.into());
                }
                let row = next.get("row").ok_or(REJECTED)?.clone();
                self.bytes += canonical(&row)?.len();
                if self.bytes > MAX_BYTES {
                    return Err(REJECTED.into());
                }
                rows.push(row);
            }
            self.check()?;
            Ok(rows)
        })();
        connection.finish(statement)?;
        result
    }
}
fn schema(connection: &mut Connection, window: &mut ReadWindow) -> Result<Vec<Value>, String> {
    let schema = window.rows(connection,
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type COLLATE BINARY, name COLLATE BINARY", 1024)?;
    for row in &schema {
        if row["type"] == "trigger" {
            let name = row["name"].as_str().ok_or(REJECTED)?;
            let sql = row["sql"].as_str().ok_or(REJECTED)?;
            let digest = format!("{:x}", Sha256::digest(sql.trim().as_bytes()));
            if row["tbl_name"] != "orchestration_v2_projection_messages"
                || !original::SEARCH_TRIGGERS
                    .iter()
                    .any(|(expected_name, expected_digest)| {
                        name == *expected_name && digest == *expected_digest
                    })
            {
                return Err(REJECTED.into());
            }
        }
    }
    for name in [
        "projection_threads",
        "projection_thread_messages",
        "projection_thread_pull_requests",
        "orchestration_events",
        "orchestration_v2_legacy_imports",
        "orchestration_v2_projection_threads",
        "orchestration_v2_turn_item_positions",
    ] {
        let row = schema
            .iter()
            .find(|row| row["name"] == name)
            .ok_or(REJECTED)?;
        let sql = row["sql"].as_str().ok_or(REJECTED)?;
        if row["type"] != "table"
            || !sql
                .get(..12)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("CREATE TABLE"))
            || !sql
                .get(12..)
                .and_then(|suffix| suffix.chars().next())
                .is_some_and(char::is_whitespace)
        {
            return Err(REJECTED.into());
        }
    }
    if !window.rows(connection, "SELECT owned.name, reference.\"table\" AS target
        FROM sqlite_schema AS owned JOIN pragma_foreign_key_list(owned.name) AS reference
        WHERE owned.type = 'table' AND (owned.name LIKE 'orchestration_%' OR owned.name LIKE 'projection_%'
        OR reference.\"table\" LIKE 'orchestration_%' OR reference.\"table\" LIKE 'projection_%') LIMIT 1", 1)?.is_empty()
    { return Err(REJECTED.into()); }
    Ok(schema)
}
fn text<'a>(row: &'a Value, key: &str) -> Result<&'a str, String> {
    row[key].as_str().ok_or_else(|| REJECTED.into())
}
fn selection(column: &str, ids: impl Iterator<Item = String>) -> String {
    // Identifiers below are source constants. Values are only independently
    // observed SQLite IDs; quote every value, including apostrophes, exactly.
    let values: Vec<_> = ids
        .map(|id| format!("'{}'", id.replace('\'', "''")))
        .collect();
    if values.is_empty() {
        "0 = 1".into()
    } else {
        format!("{column} IN ({})", values.join(","))
    }
}
fn read(
    connection: &mut Connection,
    observed_at_ms: u64,
    deadline: Instant,
) -> Result<Observation, String> {
    let mut window = ReadWindow { deadline, bytes: 0 };
    let schema = schema(connection, &mut window)?;
    let repairs = window.rows(connection, original::REPAIR, MAX_TARGETS)?;
    let import_rows = window.rows(connection, original::IMPORT, MAX_TARGETS)?;
    if repairs.len() + import_rows.len() > MAX_TARGETS {
        return Err(REJECTED.into());
    }
    let mut targets = Vec::new();
    for row in &repairs {
        let stored = execution_json::parse(text(row, "payload_json")?.as_bytes())?;
        if text(&stored, "id")? != text(row, "thread_id")? {
            return Err(REJECTED.into());
        }
        let target = Target {
            action: "repair".into(),
            thread_id: text(&stored, "id")?.into(),
            project_id: text(&stored, "projectId")?.into(),
        };
        target.validate()?;
        targets.push(target);
    }
    let mut imports = Vec::new();
    let mut event_owners = HashMap::<String, String>::new();
    for row in import_rows {
        let thread = text(&row, "thread_id")?;
        let target = Target {
            action: "import".into(),
            thread_id: thread.into(),
            project_id: text(&row, "project_id")?.into(),
        };
        target.validate()?;
        targets.push(target);
        window.check()?;
        let latest = connection.read_one(original::LATEST, &[thread])?;
        let latest_user = connection.read_one(original::LATEST_USER, &[thread])?;
        window.check()?;
        let mut previews = Vec::new();
        for preview in latest_user.into_iter().chain(latest) {
            let message = text(&preview, "message_id")?;
            if previews
                .iter()
                .any(|row: &Value| row["message_id"] == message)
            {
                continue;
            }
            if text(&preview, "thread_id")? != thread {
                return Err(REJECTED.into());
            }
            window.bytes += canonical(&preview)?.len();
            if window.bytes > MAX_BYTES {
                return Err(REJECTED.into());
            }
            previews.push(preview);
        }
        let mut event_ids = vec![
            format!("migration:v1:thread:{thread}:created"),
            format!("migration:v1:thread:{thread}:shell"),
        ];
        for preview in &previews {
            let id = text(preview, "message_id")?;
            event_ids.push(format!("migration:v1:message:{id}"));
            event_ids.push(format!("migration:v1:turn-item:{id}"));
        }
        for id in event_ids {
            if event_owners.insert(id, thread.into()).is_some() {
                return Err(REJECTED.into());
            }
        }
        imports.push(json!({"row":row,"previews":previews}));
    }
    let ids = || targets.iter().map(|target| target.thread_id.clone());
    let positions = window.rows(
        connection,
        &format!(
            "SELECT * FROM orchestration_v2_turn_item_positions WHERE {}
        ORDER BY thread_id COLLATE BINARY, turn_item_id COLLATE BINARY",
            selection("thread_id", ids())
        ),
        usize::MAX,
    )?;
    let legacy = window.rows(
        connection,
        &format!(
            "SELECT * FROM orchestration_v2_legacy_imports WHERE {}
        ORDER BY thread_id COLLATE BINARY",
            selection("thread_id", ids())
        ),
        usize::MAX,
    )?;
    let projected = window.rows(
        connection,
        &format!(
            "SELECT * FROM orchestration_v2_projection_threads WHERE {}
        ORDER BY thread_id COLLATE BINARY",
            selection("thread_id", ids())
        ),
        usize::MAX,
    )?;
    let events = window.rows(
        connection,
        &format!(
            "SELECT * FROM orchestration_events WHERE {}
        ORDER BY event_id COLLATE BINARY",
            selection("event_id", event_owners.keys().cloned())
        ),
        usize::MAX,
    )?;
    for event in &events {
        if event["aggregate_kind"] != "thread"
            || event["application_event_version"] != 2
            || event_owners
                .get(text(event, "event_id")?)
                .map(String::as_str)
                != Some(text(event, "stream_id")?)
        {
            return Err(REJECTED.into());
        }
    }
    window.check()?;
    facts::observe(
        json!({"schema":schema,"repairRows":repairs,"imports":imports,"positions":positions,
        "legacy":legacy,"projected":projected,"events":events}),
        targets,
        observed_at_ms,
    )
}
pub(super) fn observe(main: &HeldObject, owner: &str) -> Result<Observation, String> {
    let start = Instant::now();
    let observed_at_ms = now_ms()?;
    let observed = super::read::snapshot_with_authorizer(main, owner, authorize, |connection| {
        read(
            connection,
            observed_at_ms,
            start + Duration::from_millis(5000),
        )
    })?;
    if Instant::now() >= start + Duration::from_millis(5000) {
        return Err(REJECTED.into());
    }
    Ok(observed)
}
