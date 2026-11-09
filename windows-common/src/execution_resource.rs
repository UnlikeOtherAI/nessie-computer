//! Private native/service resource wire. Handles never cross the daemon lane.
use crate::custody::{valid_nonce, REJECTED};
use serde::{Deserialize, Serialize};

pub const SETTINGS_LIMIT: usize = 1024 * 1024;
pub const LEASE_MILLIS: u64 = 55_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub executor_id: String,
    pub admitted_root_key: String,
    pub physical_root_key: String,
    pub environment_id: String,
    pub database_identity: String,
    pub environment_identity: String,
    pub layout: String,
    pub database_role: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderReference {
    pub reference_id: String,
    pub instance_id: String,
    pub driver: String,
    pub role: String,
    pub identity: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evidence {
    pub source: Source,
    pub settings_identity: String,
    pub settings_digest: String,
    pub settings_length: usize,
    pub provider_references: Vec<ProviderReference>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub version: u32,
    pub resource_id: String,
    pub resource_generation: String,
    pub evidence: Evidence,
    pub custody: crate::execution::Custody,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Object {
    pub handle: u64,
    pub identity: String,
    pub kind: String,
    pub private: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "operation", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum Request {
    Authorize { executor_id: String },
    ReviewRegistration { executor_id: String, review_id: String, admitted_root_key: String, configuration: Object, source_root: Object },
    LinkRegistration { executor_id: String, review_id: String, review_digest: String },
    Register { executor_id: String, resource_id: String, evidence: Evidence, objects: Vec<Object>, watches: Vec<u64> },
    Recheck { executor_id: String, resource_id: String },
    OpenDestination { executor_id: String, resource_id: String, nonce: String, directory: Object, writer: Object, watches: Vec<u64> },
    HoldDestinationFile { executor_id: String, resource_id: String, reference: String, file: Object },
    CloseDestination { executor_id: String, resource_id: String },
    Close { executor_id: String, resource_id: String },
}
impl Request {
    pub fn executor(&self) -> &str {
        match self {
            Self::Authorize { executor_id } | Self::Register { executor_id, .. }
            | Self::Recheck { executor_id, .. } | Self::Close { executor_id, .. }
            | Self::ReviewRegistration { executor_id, .. } | Self::LinkRegistration { executor_id, .. }
            | Self::OpenDestination { executor_id, .. } | Self::HoldDestinationFile { executor_id, .. }
            | Self::CloseDestination { executor_id, .. } => executor_id,
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        let id = |s: &str| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control);
        if !id(self.executor()) { return Err(REJECTED.into()); }
        match self {
            Self::Authorize { .. } => (),
            Self::ReviewRegistration { review_id, admitted_root_key, configuration, source_root, .. } => {
                if !valid_nonce(review_id) || !id(admitted_root_key) || configuration.handle == 0
                    || configuration.kind != "configuration" || !configuration.private || !id(&configuration.identity)
                    || source_root.kind != "source-root" || source_root.handle == 0 || !source_root.private || !id(&source_root.identity) {
                    return Err(REJECTED.into());
                }
            }
            Self::LinkRegistration { review_id, review_digest, .. } => {
                if !valid_nonce(review_id) || !valid_nonce(review_digest) { return Err(REJECTED.into()); }
            }
            Self::Close { resource_id, .. } | Self::Recheck { resource_id, .. } | Self::CloseDestination { resource_id, .. } => {
                if !valid_nonce(resource_id) { return Err(REJECTED.into()); }
            }
            Self::OpenDestination { resource_id, nonce, directory, writer, watches, .. } => {
                if !valid_nonce(resource_id) || !valid_nonce(nonce)
                    || watches.is_empty() || watches.len() > 128 || watches.contains(&0)
                    || !crate::execution_destination::valid_object(directory, true)
                    || !crate::execution_destination::valid_object(writer, false) { return Err(REJECTED.into()); }
            }
            Self::HoldDestinationFile { resource_id, reference, file, .. } => {
                crate::execution_destination::filename(reference)?;
                if !valid_nonce(resource_id) || !crate::execution_destination::valid_object(file, false) {
                    return Err(REJECTED.into());
                }
            }
            Self::Register { resource_id, evidence: e, objects, watches, .. } => {
                if !valid_nonce(resource_id) || e.source.executor_id != self.executor()
                    || e.settings_length == 0 || e.settings_length > SETTINGS_LIMIT
                    || !valid_nonce(&e.settings_digest) || !id(&e.settings_identity)
                    || objects.is_empty() || objects.len() > 256 || e.provider_references.len() > 192
                    || watches.is_empty() || watches.len() > 128 || watches.contains(&0)
                    || ![&e.source.admitted_root_key, &e.source.physical_root_key, &e.source.environment_id,
                        &e.source.database_identity, &e.source.environment_identity].iter().all(|s| id(s))
                    || !matches!((e.source.layout.as_str(), e.source.database_role.as_str()),
                        ("v2-80", "authoritative-v2") | ("legacy-54", "sole-legacy")) {
                    return Err(REJECTED.into());
                }
                let mut refs = std::collections::HashSet::new();
                let mut roles = std::collections::HashSet::new();
                for r in &e.provider_references {
                    if !valid_nonce(&r.reference_id) || !refs.insert(&r.reference_id)
                        || !roles.insert((&r.instance_id, &r.role))
                        || !id(&r.instance_id) || !id(&r.identity)
                        || !["codex", "claude"].contains(&r.driver.as_str())
                        || !["continuation", "history", "credential"].contains(&r.role.as_str()) {
                        return Err(REJECTED.into());
                    }
                }
                if objects.iter().any(|o| o.handle == 0 || !id(&o.identity)
                    || !["directory", "source-root", "settings", "database", "environment", "sidecar", "configuration", "provider-home"]
                        .contains(&o.kind.as_str()) || (o.kind != "directory" && !o.private)) {
                    return Err(REJECTED.into());
                }
                for kind in ["source-root", "settings", "database", "environment", "configuration"] {
                    if objects.iter().filter(|o| o.kind == kind).count() != 1 { return Err(REJECTED.into()); }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn registration() -> Request {
        Request::Register { executor_id: "executor".into(), resource_id: "a".repeat(64),
            evidence: Evidence { source: Source { executor_id: "executor".into(), admitted_root_key: "original".into(),
                physical_root_key: format!("windows-file-id:{}", "b".repeat(64)), environment_id: "env:雪".into(),
                database_identity: "volume:db".into(), environment_identity: "volume:env".into(),
                layout: "v2-80".into(), database_role: "authoritative-v2".into() },
                settings_identity: "volume:settings".into(), settings_digest: "c".repeat(64), settings_length: 2,
                provider_references: vec![ProviderReference { reference_id: "d".repeat(64),
                    instance_id: "original-instance".into(), driver: "codex".into(), role: "history".into(), identity: "volume:home".into() }] },
            objects: ["source-root", "settings", "database", "environment", "configuration"].into_iter().enumerate()
                .map(|(i, kind)| Object { handle: (i + 1) as u64, identity: format!("codec:{i}"), kind: kind.into(), private: true }).collect(),
            watches: vec![7] }
    }
    #[test]
    fn strict_wire_acceptance_is_not_handle_or_custody_admission() {
        let value = registration(); value.validate().unwrap(); // Shape only; fake handles cannot be duplicated.
        let mut raw = serde_json::to_value(&value).unwrap();
        raw["settingsBytes"] = json!("must never cross this wire");
        assert!(serde_json::from_value::<Request>(raw).is_err());
        for mutation in 0..5 {
            let mut value = registration();
            if let Request::Register { evidence, objects, watches, .. } = &mut value {
                match mutation {
                    0 => evidence.settings_length = SETTINGS_LIMIT + 1,
                    1 => evidence.provider_references.push(evidence.provider_references[0].clone()),
                    2 => objects.push(objects[1].clone()),
                    3 => watches.clear(),
                    _ => evidence.source.database_role = "sole-legacy".into(),
                }
            }
            assert!(value.validate().is_err());
        }
    }
    #[test]
    fn source_link_wire_cannot_accept_an_approval_boolean_or_an_unheld_root() {
        let confirm = json!({"operation":"linkRegistration","executorId":"executor",
            "reviewId":"a".repeat(64),"reviewDigest":"b".repeat(64),"approved":true});
        assert!(serde_json::from_value::<Request>(confirm).is_err());
        let review = Request::ReviewRegistration { executor_id:"executor".into(),review_id:"a".repeat(64),
            admitted_root_key:"source".into(),configuration:Object {handle:1,identity:"fixture:config".into(),
                kind:"configuration".into(),private:true},source_root:Object {handle:0,identity:"fixture:root".into(),
                kind:"source-root".into(),private:true} };
        assert!(review.validate().is_err());
    }
    #[test]
    fn execution_destination_wire_cannot_supply_a_path_runtime_generation_or_arbitrary_file() {
        let directory = Object { handle: 1, identity: "component:directory".into(), kind: "directory".into(), private: true };
        let file = Object { handle: 2, identity: "component:writer".into(), kind: "database".into(), private: true };
        let value = Request::OpenDestination { executor_id: "executor".into(), resource_id: "a".repeat(64),
            nonce: "b".repeat(64), directory, writer: file.clone(), watches: vec![3] };
        value.validate().unwrap(); // Shape only; actual native handles remain required.
        for field in ["path", "runtimeGeneration", "ready", "admitted"] {
            let mut raw = serde_json::to_value(&value).unwrap();
            raw[field] = json!("caller assertion");
            assert!(serde_json::from_value::<Request>(raw).is_err());
        }
        let held = Request::HoldDestinationFile { executor_id: "executor".into(), resource_id: "a".repeat(64),
            reference: "../source.sqlite".into(), file };
        assert!(held.validate().is_err());
    }
}
