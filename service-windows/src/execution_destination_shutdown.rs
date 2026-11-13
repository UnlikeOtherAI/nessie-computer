//! Complete original shutdown selection over one service-held SQLite snapshot.
use super::{read, recovery_inputs};
use nessie_windows_common::{
    custody::REJECTED,
    execution::now_ms,
    execution_pending_effect::ROW_COLUMNS,
    execution_recovery_inputs as queries,
    execution_resource_handles::HeldObject,
    execution_shutdown::{self as facts, Observation, Policy, Projection},
    readonly_sqlite::Connection,
};
use std::{
    ffi::{c_char, c_int, c_void, CStr},
    time::{Duration, Instant},
};

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
    let column = string(second);
    let allowed = match action {
        21 | 22 => true,
        31 => [
            "json_valid",
            "json_type",
            "json_extract",
            "json_array_length",
            "coalesce",
            "json_each",
            "pragma_table_xinfo",
            "pragma_foreign_key_list",
        ]
        .contains(&column),
        19 => ["table_xinfo", "foreign_key_list"].contains(&table),
        20 => {
            queries::TABLES.contains(&table)
                || match table {
                    "orchestration_v2_effect_outbox" => ROW_COLUMNS.contains(&column),
                    "sqlite_schema" | "sqlite_master" => {
                        ["name", "type", "sql", "tbl_name"].contains(&column)
                    }
                    "pragma_table_xinfo" => ["name", "cid", "hidden"].contains(&column),
                    "pragma_foreign_key_list" => ["table", "arg"].contains(&column),
                    "json_each" => column == "value",
                    _ => false,
                }
        }
        _ => false,
    };
    if allowed {
        0
    } else {
        1
    }
}
fn selected(connection: &mut Connection, policy: &Policy) -> Result<Vec<String>, String> {
    let query = queries::queries()?.shutdown_selection;
    let params = policy.selection_parameters()?;
    let statement = connection.prepare(&query.query)?;
    let result = (|| {
        connection.bind_texts(
            statement,
            &params.iter().map(String::as_str).collect::<Vec<_>>(),
        )?;
        let mut threads = Vec::new();
        loop {
            let value = connection.next(statement)?;
            if value["done"] == true {
                return Ok(threads);
            }
            if value["done"] != false || threads.len() >= facts::MAX_TARGETS {
                return Err(REJECTED.into());
            }
            threads.push(
                value["row"]["thread_id"]
                    .as_str()
                    .ok_or(REJECTED)?
                    .to_owned(),
            );
        }
    })();
    connection.finish(statement)?;
    result
}
pub(super) fn observe(
    main: &HeldObject,
    owner: &str,
    settings: &[u8],
    selection_at_ms: u64,
    until: Instant,
) -> Result<Observation, String> {
    let now = now_ms()?;
    if now < selection_at_ms || now >= selection_at_ms.saturating_add(5000) {
        return Err(REJECTED.into());
    }
    let deadline = until
        .min(Instant::now() + Duration::from_millis(selection_at_ms.saturating_add(5000) - now));
    let policy = Policy::read(settings)?;
    let observed = read::snapshot_with_authorizer(main, owner, authorize, |connection| {
        read_snapshot(connection, &policy, now, selection_at_ms, deadline)
    })?;
    if Instant::now() >= deadline || now_ms()? >= selection_at_ms.saturating_add(5000) {
        return Err(REJECTED.into());
    }
    Ok(observed)
}
pub(super) fn read_snapshot(
    connection: &mut Connection,
    policy: &Policy,
    now: u64,
    selection_at_ms: u64,
    deadline: Instant,
) -> Result<Observation, String> {
    connection.set_deadline(deadline);
    recovery_inputs::schema(connection)?;
    read::schema(connection, "orchestration_v2_effect_outbox", ROW_COLUMNS)?;
    let threads = if policy.enabled || policy.overrides.values().any(|value| *value) {
        selected(connection, &policy)?
    } else {
        Vec::new()
    };
    let mut targets = Vec::new();
    let mut effects = Vec::new();
    let mut bytes = 0_usize;
    for thread in threads {
        let raw = recovery_inputs::read_projection(connection, &thread, now, deadline)?;
        bytes = bytes
            .checked_add(
                raw.thread_payload.len()
                    + raw.rows.iter().map(|(_, value)| value.len()).sum::<usize>(),
            )
            .ok_or(REJECTED)?;
        if bytes > queries::MAX_BYTES {
            return Err(REJECTED.into());
        }
        let projection = Projection::decode(&raw.thread_payload, &raw.rows)?;
        targets.push(projection.target(&thread, &raw.observation.input_digest)?);
        if let Some(mut effect) = facts::select(&projection, &policy, selection_at_ms)? {
            let row = connection.read_one(
                "SELECT * FROM orchestration_v2_effect_outbox WHERE effect_id = ?",
                &[&effect.effect_id],
            )?;
            facts::bind_existing(&mut effect, row)?;
            effects.push(effect);
        }
    }
    facts::observe(policy, targets, effects, now, selection_at_ms)
}
