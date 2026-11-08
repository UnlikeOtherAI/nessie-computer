//! Local owner configuration only; arbitrary paths and execution inputs are refused.
use serde::{Deserialize, Serialize};
#[derive(Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
enum Operation {
    Status,
    Save { id: String, name: String, base_url: String, scope: Scope,
        #[serde(skip_serializing_if = "Option::is_none")] api_key: Option<String> },
    Remove { id: String },
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Scope { Local, Network }
pub fn validate(value: serde_json::Value) -> Result<serde_json::Value, String> {
    let refused = || "Invalid local inference connection action.".to_owned();
    let operation: Operation = serde_json::from_value(value).map_err(|_| refused())?;
    let id = match &operation {
        Operation::Status => None,
        Operation::Save { id, name, base_url, api_key, .. } => {
            if name.trim().is_empty() || name.chars().count() > 80 || base_url.len() > 512
                || api_key.as_ref().is_some_and(|key| key.len() > 4096 || key.contains(['\r', '\n'])) {
                return Err(refused());
            }
            Some(id)
        }
        Operation::Remove { id } => Some(id),
    };
    if id.is_some_and(|id| id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')) {
        return Err(refused());
    }
    serde_json::to_value(operation).map_err(|_| refused())
}
