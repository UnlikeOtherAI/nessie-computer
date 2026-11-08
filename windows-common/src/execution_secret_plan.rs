//! Pinned 25bf84ab ProviderInstanceConfig/SecretReference wire projection.
//! This reads metadata only. CodexSettings/ClaudeSettings have no secret slots.
use crate::{custody::REJECTED, execution::value_digest, execution_json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reference {
    pub provider: String,
    pub reference: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Slot {
    pub index: u32,
    pub name: String,
    pub reference: Reference,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub environment: Vec<Slot>,
    pub config: Vec<Value>,
    pub references: Vec<Reference>,
}
pub struct Observed {
    pub selection: Selection,
    pub provider_config_digest: String,
    pub secret_providers_digest: String,
    pub accounts: Vec<String>,
}
#[cfg(test)]
#[path = "execution_secret_plan_tests.rs"]
mod tests;
fn trimmed(value: &Value) -> Result<String, String> {
    let raw = value.as_str().ok_or(REJECTED)?;
    // ECMAScript String.trim, used by the original Effect codec.
    let value = raw.trim_matches(|c| {
        matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}'
        | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
    });
    if value.is_empty() {
        return Err(REJECTED.into());
    }
    Ok(value.into())
}
fn slug(value: &Value, leading_digit: bool) -> Result<String, String> {
    let value = trimmed(value)?;
    if value.len() > 64
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        || !value.as_bytes()[0].is_ascii_alphabetic()
            && !(leading_digit && value.as_bytes()[0].is_ascii_digit())
    {
        return Err(REJECTED.into());
    }
    Ok(value)
}
fn env_name(value: &Value) -> Result<String, String> {
    let value = trimmed(value)?;
    if value.len() > 128
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
        || !(value.as_bytes()[0].is_ascii_alphabetic() || value.as_bytes()[0] == b'_')
    {
        return Err(REJECTED.into());
    }
    Ok(value)
}
pub fn account(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}
pub fn op_reference(value: &str) -> bool {
    let Some(value) = value.strip_prefix("op://").filter(|_| value.len() <= 1024) else {
        return false;
    };
    let (path, query) = value
        .split_once('?')
        .map_or((value, None), |(a, b)| (a, Some(b)));
    if let Some(query) = query {
        let Some((key, value)) = query.split_once('=') else {
            return false;
        };
        if key.is_empty()
            || value.is_empty()
            || !key.bytes().all(|c| c.is_ascii_lowercase() || c == b'-')
            || !value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        {
            return false;
        }
    }
    let parts = path.split('/').collect::<Vec<_>>();
    (3..=4).contains(&parts.len())
        && parts.iter().all(|part| {
            let edge = |c: u8| c.is_ascii_alphanumeric() || b"._-".contains(&c);
            !part.is_empty()
                && edge(part.as_bytes()[0])
                && edge(*part.as_bytes().last().unwrap())
                && part.bytes().all(|c| edge(c) || c == b' ')
        })
}
fn reference(value: &Value) -> Result<Reference, String> {
    if !value.is_object() {
        return Err(REJECTED.into());
    }
    let provider = slug(&value["provider"], true)?;
    let reference = trimmed(&value["reference"])?;
    if !op_reference(&reference) {
        return Err(REJECTED.into());
    }
    Ok(Reference {
        provider,
        reference,
    })
}
fn optional_bool(raw: &Value, output: &mut Map<String, Value>, name: &str) -> Result<(), String> {
    if let Some(value) = raw.get(name) {
        output.insert(name.into(), Value::Bool(value.as_bool().ok_or(REJECTED)?));
    }
    Ok(())
}
pub fn observe(bytes: &[u8], instance_id: &str, driver: &str) -> Result<Observed, String> {
    let settings = execution_json::parse(bytes)?;
    let raw = settings["providerInstances"]
        .get(instance_id)
        .ok_or(REJECTED)?;
    let original_driver = slug(&raw["driver"], false)?;
    if !raw.is_object()
        || !matches!(
            (driver, original_driver.as_str()),
            ("codex", "codex") | ("claude", "claudeAgent")
        )
        || raw["enabled"] == false
        || raw["config"]["enabled"] == false
    {
        return Err(REJECTED.into());
    }
    let mut encoded = Map::new();
    encoded.insert("driver".into(), json!(original_driver));
    for name in ["displayName", "accentColor"] {
        if let Some(value) = raw.get(name) {
            encoded.insert(name.into(), json!(trimmed(value)?));
        }
    }
    optional_bool(raw, &mut encoded, "enabled")?;
    if let Some(config) = raw.get("config") {
        encoded.insert("config".into(), config.clone());
    }
    let mut slots = Vec::new();
    if let Some(environment) = raw.get("environment") {
        let environment = environment.as_array().ok_or(REJECTED)?;
        if environment.len() > 256 {
            return Err(REJECTED.into());
        }
        let mut encoded_environment = Vec::new();
        for (index, item) in environment.iter().enumerate() {
            if !item.is_object() {
                return Err(REJECTED.into());
            }
            let name = env_name(&item["name"])?;
            let value = item
                .get("value")
                .map(|v| v.as_str().ok_or(REJECTED))
                .transpose()?
                .unwrap_or("");
            let sensitive = item
                .get("sensitive")
                .map(|v| v.as_bool().ok_or(REJECTED))
                .transpose()?
                .unwrap_or(false);
            let mut entry = Map::new();
            entry.insert("name".into(), json!(name));
            entry.insert("value".into(), json!(value));
            entry.insert("sensitive".into(), json!(sensitive));
            optional_bool(item, &mut entry, "valueRedacted")?;
            if let Some(secret) = item.get("secret") {
                let reference = reference(secret)?;
                entry.insert("value".into(), json!(""));
                entry.insert("sensitive".into(), json!(true));
                entry.insert("secret".into(), json!(reference));
                slots.push(Slot {
                    index: index as u32,
                    name,
                    reference,
                });
            }
            encoded_environment.push(Value::Object(entry));
        }
        encoded.insert("environment".into(), Value::Array(encoded_environment));
    }
    let empty = Map::new();
    let providers = settings
        .get("secretProviders")
        .map(|v| v.as_object().ok_or(REJECTED))
        .transpose()?
        .unwrap_or(&empty);
    let mut encoded_providers = Map::new();
    for (id, entry) in providers {
        if !entry.is_object() {
            return Err(REJECTED.into());
        }
        let id = slug(&json!(id), true)?;
        let mut result = Map::new();
        result.insert("kind".into(), json!(slug(&entry["kind"], true)?));
        result.insert("label".into(), json!(trimmed(&entry["label"])?));
        if let Some(config) = entry.get("config") {
            result.insert("config".into(), config.clone());
        }
        if encoded_providers
            .insert(id, Value::Object(result))
            .is_some()
        {
            return Err(REJECTED.into());
        }
    }
    let mut accounts = Vec::new();
    for slot in &slots {
        let entry = encoded_providers
            .get(&slot.reference.provider)
            .ok_or(REJECTED)?;
        let selected = entry["config"]["account"].as_str().ok_or(REJECTED)?;
        if entry["kind"] != "one_password" || !account(selected) {
            return Err(REJECTED.into());
        }
        accounts.push(selected.into());
    }
    Ok(Observed {
        selection: Selection {
            references: slots.iter().map(|s| s.reference.clone()).collect(),
            environment: slots,
            config: vec![],
        },
        provider_config_digest: value_digest(&Value::Object(encoded))?,
        secret_providers_digest: value_digest(&Value::Object(encoded_providers))?,
        accounts,
    })
}
