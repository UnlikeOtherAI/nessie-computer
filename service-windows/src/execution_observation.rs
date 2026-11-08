//! Strict native identity decoding, consumed only from held provider stdout.
use crate::execution_key::sha;
use nessie_windows_common::execution::now_ms;
use serde_json::{json, Value};
pub(crate) fn native_identity(driver: &str, bytes: &[u8]) -> Option<Value> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let (id, message) = match driver {
        "codex" if value.get("error").is_none() => {
            let id = value.get("result")?.get("thread")?.get("id")?.as_str()?;
            let message = match &value["id"] {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => return None,
            };
            (id, message)
        }
        "claude" if value["type"] == "system" && value["subtype"] == "init" => (
            value["session_id"].as_str()?,
            value["uuid"].as_str()?.to_owned(),
        ),
        _ => return None,
    };
    if !nessie_windows_common::execution::identifier(id)
        || !nessie_windows_common::execution::identifier(&message)
    {
        return None;
    }
    Some(
        json!({"nativeId":id,"observation":{"kind":"service-held-provider-stdout",
        "frameDigest":sha(bytes),"requestId":message,"observedAtMs":now_ms().ok()?}}),
    )
}
