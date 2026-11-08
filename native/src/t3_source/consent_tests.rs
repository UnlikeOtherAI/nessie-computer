//! Codec/denial tests are not affirmative OS-owner or installed launch evidence.
use super::{consent_contract::{Challenge,Verification},issuer_contract::{Source,canonical,signing_bytes},
    issuer_store::Key,issuer_client::Issuer,consent_words};
use serde_json::{Value,json};
use ed25519_dalek::{SigningKey,Signer,Verifier};

fn challenge()->Value {
    let uuid="d18f1396-74e1-4329-bbaa-285424f1fb42";
    json!({"version":1,"challengeId":uuid,"nonce":"AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
        "requestId":uuid,"executorId":uuid,"environmentId":"original:environment","admittedRootKey":"installation-one",
        "physicalRootKey":"windows-file-id:original","databaseIdentity":"volume:database","environmentIdentity":"volume:environment",
        "organizationId":uuid,"teamId":uuid,"recipient":{"subject":"uoa:person","organizationId":"uoa:org","teamId":"uoa:team"},
        "selection":{"kind":"threads","threadIds":["retained:b","retained:a"],"projectIds":["original:p2","original:p1"]},
        "purpose":"retained-import-read-publish","grantGeneration":uuid,"captureGeneration":"capture:unchanged",
        "acceptedBaseline":"not_attested_by_original_source","issuedAtMs":999000,"expiresAtMs":1120000,
        "grantExpiresAtMs":1100000,"issuerEnrollmentId":uuid,"issuerKeyId":"a".repeat(64)})
}
#[test]
fn exact_tuple_orders_are_significant_and_extra_historical_claims_refuse() {
    let c:Challenge=serde_json::from_value(challenge()).unwrap();c.validate(1000000).unwrap();
    let mut other=challenge();other["selection"]["projectIds"]=json!(["original:p1","original:p2"]);
    assert_ne!(c.digest().unwrap(),serde_json::from_value::<Challenge>(other).unwrap().digest().unwrap());
    let mut other=challenge();other["historicalOwner"]=json!(true);
    assert!(serde_json::from_value::<Challenge>(other).is_err());
    for field in ["issuerEnrollmentId","issuerKeyId","captureGeneration","databaseIdentity"] {
        let mut other=challenge();other[field]=json!("other");
        let parsed:Challenge=serde_json::from_value(other).unwrap();assert_ne!(c.digest().unwrap(),parsed.digest().unwrap());
    }
}
#[test]
fn canonical_signature_domain_and_payload_match_javascript_contract() {
    let payload=json!({"z":["雪",2,1],"a":{"b":true,"a":null}});
    assert_eq!(canonical(&payload).unwrap(),"{\"a\":{\"a\":null,\"b\":true},\"z\":[\"雪\",2,1]}");
    let bytes=signing_bytes("nessie.t3.retained-import.live.v1",&payload).unwrap();
    assert_eq!(String::from_utf8(bytes.clone()).unwrap(),
        "{\"domain\":\"nessie.t3.retained-import.live.v1\",\"payload\":{\"a\":{\"a\":null,\"b\":true},\"z\":[\"雪\",2,1]}}");
    let fixture_key=SigningKey::from_bytes(&[42;32]);let signature=fixture_key.sign(&bytes);
    fixture_key.verifying_key().verify(&bytes,&signature).unwrap();
    assert!(fixture_key.verifying_key().verify(&signing_bytes("nessie.t3.retained-import.approval.v1",&payload).unwrap(),&signature).is_err());
    assert!(canonical(&json!(1.5)).is_err());
}
#[test]
fn verification_expiry_nonce_and_identity_fail_closed() {
    let mut v:Verification=serde_json::from_value(json!({"verificationId":"d18f1396-74e1-4329-bbaa-285424f1fb42",
        "nonce":"AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM","issuedAtMs":999000,"expiresAtMs":1010000})).unwrap();
    v.validate(1000000,1100000).unwrap();assert!(v.validate(1010000,1100000).is_err());
    assert!(v.validate(1000000,1009999).is_err());v.nonce.replace_range(42..43,"B");
    assert!(v.validate(1000000,1100000).is_err());
}
#[test]
fn selection_bounds_and_both_duplicate_lists_refuse_without_truncation() {
    for selection in [json!({"kind":"threads","threadIds":["a","a"],"projectIds":[]}),
        json!({"kind":"threads","threadIds":["a"],"projectIds":["p","p"]}),
        json!({"kind":"threads","threadIds":["雪".repeat(86)],"projectIds":[]})] {
        let mut c=challenge();c["selection"]=selection;
        assert!(serde_json::from_value::<Challenge>(c).unwrap().validate(1000000).is_err());
    }
}
#[test]
fn source_owner_cannot_read_system_key_store_or_mint_bootstrap() {
    let process=nessie_windows_common::process::Process::open(std::process::id()).unwrap();
    assert_ne!(process.sid,"S-1-5-18","this denial test must run as an ordinary source owner");
    let source=Source::from_value(&challenge()).unwrap();
    assert!(Key::open(&source,&process.sid,false).is_err());
    assert!(Key::open(&source,&process.sid,true).is_err());
    assert!(Issuer::open(&"a".repeat(64)).is_err());
}
#[test]
fn secure_prompt_shows_recipient_scope_and_unattested_baseline_without_bidi_injection() {
    let mut c=challenge();c["recipient"]["subject"]=json!("subject\u{202e}hidden");
    let (_,message)=consent_words::prompt(&c,"approve").unwrap();
    assert!(message.contains("not_attested_by_original_source"));
    assert!(message.contains("retained:b") && message.contains("original:p2"));
    assert!(message.contains("\\u{202e}") && !message.contains('\u{202e}'));
    c["recipient"]["subject"]=json!("x".repeat(32767));assert!(consent_words::prompt(&c,"approve").is_err());
}
