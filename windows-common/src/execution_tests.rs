use super::*;
use serde_json::json;
fn binding() -> serde_json::Value {
    let sha = format!("sha256:{}", "a".repeat(64));
    json!({"executorId":"executor","environmentId":"environment","threadId":"thread",
        "providerInstanceId":"instance","connectionEpoch":"epoch","runtimeGeneration":"runtime",
        "correlationId":"correlation","commandId":"command","requestSha256":sha,
        "relayHmac":format!("hmac-sha256:{}","b".repeat(64)),"actorReference":sha,
        "initiationReference":sha,"sourceEvidenceDigest":sha,"sourceRootKey":"root",
        "sourceGeneration":"source","driver":"codex","continuationHomeKey":"continuation",
        "historyHomeKey":"history","credentialBindingId":"credential"})
}
fn admission() -> serde_json::Value {
    json!({"version":1,"phase":"reserve","binding":binding(),"reservationId":"c".repeat(64),
        "issuerKeyId":"d".repeat(64),"releaseDigest":"e".repeat(64),"nonce":"f".repeat(64),
        "issuedAtMs":1000,"expiresAtMs":6000})
}
#[test]
fn admission_expiry_and_phase_cannot_be_reinterpreted() {
    let value: Admission = serde_json::from_value(admission()).unwrap();
    assert!(value.validate(5999).is_ok());
    assert!(value.validate(6000).is_err());
    let mut future = value.clone();
    future.issued_at_ms = 5000;
    future.expires_at_ms = 10000;
    assert!(future.validate(1000).is_err());
    let mut extended = value.clone();
    extended.expires_at_ms = 6001;
    assert!(extended.validate(1000).is_err());
    let mut placeholder = value.clone();
    placeholder.provider_session_id = Some("placeholder".into());
    assert!(placeholder.validate(1000).is_err());
    let mut launch = value;
    launch.phase = "launch".into();
    assert!(launch.validate(1000).is_err());
    launch.launch_digest = Some(format!("sha256:{}", "a".repeat(64)));
    assert!(launch.validate(1000).is_err());
    launch.process_purpose = Some(ProcessPurpose::ClaudeHistoryRead);
    assert!(launch.validate(1000).is_ok());
    launch.phase = "associate".into();
    launch.provider_session_id = Some("original-session".into());
    assert!(launch.validate(1000).is_err());
    let mut raw = admission();
    raw["nativeId"] = json!("placeholder");
    assert!(serde_json::from_value::<Admission>(raw).is_err());
}
#[test]
fn exact_signature_bytes_and_safe_canonical_numbers() {
    let payload = "{\"snow\":\"雪\"}";
    let bytes = signing_bytes(ADMISSION_DOMAIN, payload);
    assert_eq!(bytes[ADMISSION_DOMAIN.len()], 10);
    assert_eq!(&bytes[ADMISSION_DOMAIN.len() + 1..], payload.as_bytes());
    assert_ne!(bytes, signing_bytes(INSPECTION_DOMAIN, payload));
    assert_eq!(
        canonical(&json!({"b":2,"a":1})).unwrap(),
        "{\"a\":1,\"b\":2}"
    );
    assert!(canonical(&json!(9_007_199_254_740_992u64)).is_err());
}
#[test]
fn original_target_ledger_and_sha_hmac_remain_distinct() {
    let mut original = binding();
    original
        .as_object_mut()
        .unwrap()
        .remove("sourceEvidenceDigest");
    let graph: Graph = serde_json::from_value(json!({"version":1,"nonce":"f".repeat(64),
        "binding":original,"sourceRevision":"25bf84ab07f53f141c20239c63e383823a9d5ea0",
        "targets":[],"issuedAtMs":1000,"expiresAtMs":6000}))
    .unwrap();
    let b = &graph.binding;
    let mut inspect:Inspection=serde_json::from_value(json!({"version":1,"inspectionId":"a".repeat(64),
        "issuerKeyId":"d".repeat(64),"nonce":graph.nonce,"executorId":b.executor_id,
        "environmentId":b.environment_id,"connectionEpoch":b.connection_epoch,"runtimeGeneration":b.runtime_generation,
        "correlationId":b.correlation_id,"commandId":b.command_id,"requestSha256":b.request_sha256,
        "relayHmac":b.relay_hmac,"actorReference":b.actor_reference,"initiationReference":b.initiation_reference,
        "sourceRootKey":b.source_root_key,"sourceGeneration":b.source_generation,"sourceRevision":graph.source_revision,
        "targets":[],"issuedAtMs":1000,"expiresAtMs":6000})).unwrap();
    assert!(inspect.validate(1000).is_ok());
    assert!(inspect.matches_graph(&graph).is_ok());
    inspect.targets.push(Target {
        kind: "project".into(),
        id: "guessed".into(),
        scope: "existing".into(),
        environment_id: None,
    });
    assert!(inspect.matches_graph(&graph).is_err());
    inspect.targets.clear();
    inspect.relay_hmac = inspect.request_sha256.clone();
    assert!(inspect.validate(1000).is_err());
    assert!(inspect.matches_graph(&graph).is_err());
}
