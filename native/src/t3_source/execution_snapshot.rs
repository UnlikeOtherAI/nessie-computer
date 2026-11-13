//! Finite snapshots on the execution resource's existing readonly connection.
//! This state never opens a path and cannot issue service/custody admission.
use super::{consent_state::random_id, handles::fail, resource::Resource};
use crate::protocol::NativeError;
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Default)]
pub(super) struct Snapshot {
    id: Option<String>,
    statements: HashSet<u64>,
    failed: bool,
}
impl Snapshot {
    pub(super) fn dispatch(&mut self, request: &Value, source: &mut Resource) -> Result<Value, NativeError> {
        if self.failed { return Err(fail()); }
        let result = self.dispatch_live(request, source);
        if result.is_err() { self.failed = true; }
        result
    }
    fn dispatch_live(&mut self, request: &Value, source: &mut Resource) -> Result<Value, NativeError> {
        source.recheck()?;
        let fields = request.as_object().ok_or_else(fail)?;
        let result = match request["op"].as_str().ok_or_else(fail)? {
            "executionSnapshotOpen" => {
                if fields.len() != 1 || self.id.is_some() { return Err(fail()); }
                let id = random_id()?;
                source.database.transaction("BEGIN")?;
                self.id = Some(id.clone());
                // A real first read pins the SQLite WAL snapshot before return.
                let first = source.database.query("schemaVersion", None)?["statement"].as_u64().ok_or_else(fail)?;
                let read = source.database.next(first);
                source.database.finish(first)?;
                read?;
                Ok(json!({"snapshotId":id}))
            },
            "executionSnapshotRead" => {
                if fields.len() != 3 || self.id.as_deref() != request["snapshotId"].as_str() || self.id.is_none() {
                    return Err(fail());
                }
                let read = &request["request"];
                let op = read["op"].as_str().ok_or_else(fail)?;
                if op == "next" || op == "finalize" {
                    let id = read["statement"].as_u64().ok_or_else(fail)?;
                    if !self.statements.contains(&id) { return Err(fail()); }
                }
                let result = source.database.dispatch_read(read)?;
                if op == "query" {
                    self.statements.insert(result["statement"].as_u64().ok_or_else(fail)?);
                } else if op == "finalize" {
                    self.statements.remove(&read["statement"].as_u64().ok_or_else(fail)?);
                }
                Ok(result)
            },
            "executionSnapshotClose" => {
                if fields.len() != 3 || self.id.is_none() || self.id.as_deref() != request["snapshotId"].as_str() {
                    return Err(fail());
                }
                let action = request["action"].as_str().ok_or_else(fail)?;
                if !["COMMIT", "ROLLBACK"].contains(&action) { return Err(fail()); }
                self.id = None;
                // Abandoned iterators never survive into the next snapshot.
                for statement in self.statements.drain() { source.database.finish(statement)?; }
                source.database.transaction(action)?;
                Ok(json!({"closed":true}))
            },
            _ => Err(fail()),
        }?;
        source.recheck()?;
        Ok(result)
    }
}
