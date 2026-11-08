//! Product-specific prospective linkage only. Never mirrors homes or machine keys.
use nessie_windows_common::{custody::REJECTED, execution_resource::Object,
    execution_resource_handles::{Duplicator, HeldObject}, process::Process, release::pin_service_private};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs::{File, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf},
    sync::{Mutex, OnceLock}, time::{Duration, Instant}};

struct Review {
    caller: Process, configuration: HeldObject, source_root: HeldObject, admitted_root_key: String,
    metadata: Value, digest: String, deadline: Instant,
    executor: String, root: PathBuf, _service: Vec<File>,
}
static REVIEWS: OnceLock<Mutex<HashMap<String, Review>>> = OnceLock::new();
fn reviews() -> &'static Mutex<HashMap<String, Review>> { REVIEWS.get_or_init(|| Mutex::new(HashMap::new())) }
fn sha(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn canonical(value: &Value) -> Result<String, String> { nessie_windows_common::execution::canonical(value) }

// This comparison confers no authority alone: metadata() supplies both values
// from separately held OS objects after source-owner/service ACL verification.
fn paired_origin(state: &Value, user: &Value, executor: &str) -> Result<String, String> {
    if state["executorId"] != executor || user["executorId"] != executor
        || state["machinePublicKey"].as_str().is_none_or(str::is_empty)
        || user["machinePublicKey"] != state["machinePublicKey"] || user["apiBaseUrl"] != state["apiBaseUrl"] {
        return Err(REJECTED.into());
    }
    let api = url::Url::parse(state["apiBaseUrl"].as_str().ok_or(REJECTED)?).map_err(|_| REJECTED)?;
    if api.scheme() != "https" || !api.username().is_empty() || api.password().is_some() { return Err(REJECTED.into()); }
    Ok(api.origin().ascii_serialization())
}

/// Both paths are service-owned, derived from the authenticated enrollment ID.
/// User config is read only from the duplicated source-owner file object.
fn metadata(root: &Path, executor: &str, caller: &Process, key: &str,
    config: &HeldObject, source: &HeldObject) -> Result<(Value, Vec<File>), String> {
    config.recheck(&caller.sid)?;
    source.recheck(&caller.sid)?;
    let directory = crate::paths::executor_state_dir(root, executor)?;
    let mut pins = vec![pin_service_private(root, true)?,
        pin_service_private(&crate::paths::executors_root(root), true)?, pin_service_private(&directory, true)?];
    let mut owner = String::new();
    let mut owner_file = pin_service_private(&directory.join(crate::paths::PAIRED_BY_FILE), false)?;
    (&mut owner_file).take(257).read_to_string(&mut owner).map_err(|_| REJECTED)?;
    if owner.len() > 256 || owner.trim() != caller.sid { return Err(REJECTED.into()); }
    let mut state_file = pin_service_private(&directory.join(crate::paths::EXECUTOR_STATE_FILE), false)?;
    let mut service = Vec::new();
    (&mut state_file).take(1_048_577).read_to_end(&mut service).map_err(|_| REJECTED)?;
    if service.len() > 1_048_576 { return Err(REJECTED.into()); }
    let state: Value = serde_json::from_slice(&service).map_err(|_| REJECTED)?;
    service.fill(0);
    let mut user_bytes = config.bytes(256 * 1024)?;
    let user: Value = serde_json::from_slice(&user_bytes).map_err(|_| REJECTED)?;
    let digest = sha(&user_bytes); user_bytes.fill(0);
    let paired_origin = paired_origin(&state, &user, executor)?;
    let revision = user["descriptor"]["revision"].as_u64().ok_or(REJECTED)?;
    let homes = user["t3SourceHomes"].as_array().ok_or(REJECTED)?;
    if homes.is_empty() || homes.len() > 128 || !homes.iter().any(|home| home["admittedRootKey"] == key) {
        return Err(REJECTED.into());
    }
    pins.push(owner_file); pins.push(state_file);
    Ok((json!({"version":1,"purpose":"execution-source-registration","executorId":executor,
        "ownerSid":caller.sid,"admittedRootKey":key,
        "physicalRootKey":format!("windows-file-id:{}",sha(source.description.identity.as_bytes())),
        "configurationIdentity":config.description.identity,"configurationDigest":digest,
        "descriptorRevision":revision,"pairedApiOrigin":paired_origin,
        "machinePublicKeyDigest":sha(state["machinePublicKey"].as_str().ok_or(REJECTED)?.as_bytes()),
        "serviceEnrollmentDigest":sha(canonical(&json!({"executorId":state["executorId"],
            "apiBaseUrl":state["apiBaseUrl"],"machinePublicKey":state["machinePublicKey"],
            "connectionEpoch":state["connectionEpoch"]}))?.as_bytes())}), pins))
}
fn link_directory(root: &Path, executor: &str, create: bool) -> Result<(PathBuf, Vec<File>), String> {
    crate::paths::executor_state_dir(root, executor)?; // Existing strict identifier policy.
    let mut pins = vec![pin_service_private(root, true)?];
    let directory = root.join("execution-source-links");
    if create { std::fs::create_dir_all(&directory).map_err(|_| REJECTED)?; }
    pins.push(pin_service_private(&directory, true)?);
    let directory = directory.join(executor);
    if create { std::fs::create_dir_all(&directory).map_err(|_| REJECTED)?; }
    pins.push(pin_service_private(&directory, true)?);
    Ok((directory, pins))
}
fn linked(root: &Path, executor: &str, metadata: &Value) -> Result<bool, String> {
    let path = root.join("execution-source-links").join(executor).join(link_name(metadata)?);
    if !path.try_exists().map_err(|_| REJECTED)? { return Ok(false); }
    let (_, _pins) = link_directory(root, executor, false)?;
    let mut bytes = Vec::new();
    pin_service_private(&path, false)?.take(16385).read_to_end(&mut bytes).map_err(|_| REJECTED)?;
    if bytes.len() > 16384 { return Err(REJECTED.into()); }
    let record: Value = serde_json::from_slice(&bytes).map_err(|_| REJECTED)?;
    Ok(record == *metadata)
}
fn link_name(metadata: &Value) -> Result<String, String> {
    Ok(format!("{}.json", sha(metadata["admittedRootKey"].as_str().ok_or(REJECTED)?.as_bytes())))
}
pub(super) fn cleanup() {
    if let Ok(mut reviews) = reviews().lock() {
        reviews.retain(|_, r| r.caller.alive() && Instant::now() < r.deadline);
    }
}
pub(super) fn review(root: &Path, caller: &Process, executor: &str, review_id: &str,
    admitted_root_key: &str, object: &Object, source_object: &Object) -> Result<Value, String> {
    cleanup();
    let mut reviews = reviews().lock().map_err(|_| REJECTED)?;
    if reviews.len() >= 64 || reviews.contains_key(review_id) { return Err(REJECTED.into()); }
    let duplicate = Duplicator::new(caller)?;
    let config = duplicate.file(object, &caller.sid)?;
    let source = duplicate.file(source_object, &caller.sid)?;
    let (metadata, pins) = metadata(root, executor, caller, admitted_root_key, &config, &source)?;
    let mut bytes = config.bytes(256 * 1024)?;
    let user: Value = serde_json::from_slice(&bytes).map_err(|_| REJECTED)?; bytes.fill(0);
    let home = user["t3SourceHomes"].as_array().ok_or(REJECTED)?.iter()
        .find(|home| home["admittedRootKey"] == admitted_root_key).ok_or(REJECTED)?;
    let source_path = home["stateDirectory"].as_str().ok_or(REJECTED)?;
    let already_linked = linked(root, executor, &metadata)?;
    let digest = sha(canonical(&metadata)?.as_bytes());
    let result = json!({"linked":already_linked,"reviewId":review_id,"reviewDigest":digest,
        "registration":metadata,"admittedRootKey":admitted_root_key,"sourceStateDirectory":source_path});
    if !already_linked {
        let observed = Process::open(caller.generation.pid)?;
        if observed.generation != caller.generation { return Err(REJECTED.into()); }
        reviews.insert(review_id.into(), Review { caller: observed, configuration: config, source_root: source,
            admitted_root_key: admitted_root_key.into(), metadata, digest,
            deadline: Instant::now() + Duration::from_secs(300), executor: executor.into(), root: root.into(), _service:pins });
    }
    Ok(result)
}
/// Only the fixed protected resource helper calls this after its secure-desktop
/// source-owner affirmation. The service requires the exact held review peer.
pub(super) fn confirm(caller: &Process, executor: &str, review_id: &str, digest: &str) -> Result<Value, String> {
    let review = reviews().lock().map_err(|_| REJECTED)?.remove(review_id).ok_or(REJECTED)?;
    if !caller.alive() || caller.generation != review.caller.generation || executor != review.executor
        || digest != review.digest || Instant::now() >= review.deadline { return Err(REJECTED.into()); }
    let (current, _pins) = metadata(&review.root, executor, caller, &review.admitted_root_key,
        &review.configuration, &review.source_root)?;
    if current != review.metadata { return Err(REJECTED.into()); }
    let (directory, _links) = link_directory(&review.root, executor, true)?;
    let draft = directory.join(format!("{review_id}.draft"));
    let mut output = OpenOptions::new().write(true).create_new(true).open(&draft).map_err(|_| REJECTED)?;
    output.write_all(canonical(&current)?.as_bytes()).and_then(|()| output.sync_all()).map_err(|_| REJECTED)?;
    drop(output);
    let pinned = pin_service_private(&draft, false)?; drop(pinned);
    std::fs::rename(&draft, directory.join(link_name(&current)?)).map_err(|_| REJECTED)?;
    if !linked(&review.root, executor, &current)? { return Err(REJECTED.into()); }
    Ok(json!({"linked":true,"reviewId":review_id,"reviewDigest":digest}))
}
pub(super) fn require_link(root: &Path, executor: &str, caller: &Process, key: &str,
    config: &HeldObject, source: &HeldObject) -> Result<(), String> {
    let (current, _pins) = metadata(root, executor, caller, key, config, source)?;
    if !linked(root, executor, &current)? { return Err("t3_execution_source_registration_unlinked".into()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paired_registration_comparison_rejects_cross_enrollment_and_missing_identity() {
        let state = json!({"executorId":"fixture", "apiBaseUrl":"https://api.example.test",
            "machinePublicKey":"public-test-value"});
        assert_eq!(paired_origin(&state, &state, "fixture").unwrap(), "https://api.example.test");
        for (field, value) in [("executorId", json!("other")), ("machinePublicKey", json!("other-key")),
            ("apiBaseUrl", json!("https://api.example.test/other-enrollment"))] {
            let mut user = state.clone(); user[field] = value;
            assert!(paired_origin(&state, &user, "fixture").is_err());
        }
        for field in ["machinePublicKey", "apiBaseUrl", "executorId"] {
            let mut absent = state.clone(); absent.as_object_mut().unwrap().remove(field);
            assert!(paired_origin(&absent, &absent, "fixture").is_err());
        }
        let mut cleartext = state;
        cleartext["apiBaseUrl"] = json!("http://api.example.test");
        assert!(paired_origin(&cleartext, &cleartext, "fixture").is_err());
        // This is a policy comparison only. It never creates an OS admission,
        // source link, approval receipt, resource or historical identity.
    }
}
