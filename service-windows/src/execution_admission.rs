//! Same-enrolled-origin RS256 validation. Neither response keys nor arbitrary URLs grant authority.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use nessie_windows_common::{
    custody::REJECTED,
    execution::{now_ms, signing_bytes, Admission, SignedAdmission, ADMISSION_DOMAIN},
    release::pin_service_private,
};
use rsa::{
    pkcs1v15::{Signature, VerifyingKey},
    signature::Verifier,
    traits::PublicKeyParts,
    BigUint, RsaPublicKey,
};
use serde_json::Value;
use sha2::Sha256;
use std::{
    io::Read,
    path::Path,
    time::{Duration, Instant},
};

pub fn paired(root: &Path, executor: &str, owner: &str) -> Result<(String, String), String> {
    let directory = crate::paths::executor_state_dir(root, executor)?;
    let _root = pin_service_private(root, true)?;
    let _parent = pin_service_private(&crate::paths::executors_root(root), true)?;
    let _directory = pin_service_private(&directory, true)?;
    let mut sid = String::new();
    pin_service_private(&directory.join(crate::paths::PAIRED_BY_FILE), false)?
        .take(256)
        .read_to_string(&mut sid)
        .map_err(|_| REJECTED)?;
    if sid.trim() != owner {
        return Err(REJECTED.into());
    }
    let mut bytes = Vec::new();
    pin_service_private(&directory.join(crate::paths::EXECUTOR_STATE_FILE), false)?
        .take(1048577)
        .read_to_end(&mut bytes)
        .map_err(|_| REJECTED)?;
    if bytes.len() > 1048576 {
        return Err(REJECTED.into());
    }
    let state: Value = serde_json::from_slice(&bytes).map_err(|_| REJECTED)?;
    if state["executorId"] != executor {
        return Err(REJECTED.into());
    }
    let url =
        url::Url::parse(state["apiBaseUrl"].as_str().ok_or(REJECTED)?).map_err(|_| REJECTED)?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err(REJECTED.into());
    }
    let epoch = state["connectionEpoch"]
        .as_str()
        .ok_or(REJECTED)?
        .to_owned();
    Ok((url.origin().ascii_serialization(), epoch))
}

pub fn verify(root: &Path, owner: &str, signed: &SignedAdmission) -> Result<Admission, String> {
    let admission: Admission = serde_json::from_str(&signed.payload).map_err(|_| REJECTED)?;
    admission.validate(now_ms()?)?;
    verify_signature(
        root,
        owner,
        signed,
        ADMISSION_DOMAIN,
        &admission.binding.executor_id,
        &admission.binding.connection_epoch,
    )?;
    admission.validate(now_ms()?)?;
    Ok(admission)
}
pub fn inspection(
    root: &Path,
    owner: &str,
    signed: &SignedAdmission,
) -> Result<nessie_windows_common::execution::Inspection, String> {
    use nessie_windows_common::execution::{Inspection, INSPECTION_DOMAIN};
    let inspection: Inspection = serde_json::from_str(&signed.payload).map_err(|_| REJECTED)?;
    inspection.validate(now_ms()?)?;
    verify_signature(
        root,
        owner,
        signed,
        INSPECTION_DOMAIN,
        &inspection.executor_id,
        &inspection.connection_epoch,
    )?;
    inspection.validate(now_ms()?)?;
    Ok(inspection)
}
pub(crate) fn verify_signature(
    root: &Path,
    owner: &str,
    signed: &SignedAdmission,
    domain: &str,
    executor: &str,
    epoch: &str,
) -> Result<(), String> {
    let started = Instant::now();
    let before = paired(root, executor, owner)?;
    if before.1 != epoch {
        return Err(REJECTED.into());
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .https_only(true)
        .max_redirects(0)
        .timeout_global(Some(Duration::from_secs(3)))
        .build()
        .into();
    let mut response = agent
        .get(&format!("{}/.well-known/jwks.json", before.0))
        .call()
        .map_err(|_| REJECTED)?;
    if response.status() != 200 {
        return Err(REJECTED.into());
    }
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| REJECTED)?;
    if bytes.len() > 65536 {
        return Err(REJECTED.into());
    }
    let jwks: Value = serde_json::from_slice(&bytes).map_err(|_| REJECTED)?;
    let keys = jwks["keys"].as_array().ok_or(REJECTED)?;
    if keys.len() > 16 {
        return Err(REJECTED.into());
    }
    let matched = keys
        .iter()
        .filter(|key| key["kid"] == signed.key_id)
        .collect::<Vec<_>>();
    if matched.len() != 1 {
        return Err(REJECTED.into());
    }
    let key = matched[0];
    if key["kty"] != "RSA" || key["alg"] != "RS256" || key["use"] != "sig" {
        return Err(REJECTED.into());
    }
    let n = decode(key["n"].as_str().ok_or(REJECTED)?)?;
    let e = decode(key["e"].as_str().ok_or(REJECTED)?)?;
    if n.len() < 256 || n.len() > 1024 || e.len() > 8 {
        return Err(REJECTED.into());
    }
    let public = RsaPublicKey::new(BigUint::from_bytes_be(&n), BigUint::from_bytes_be(&e))
        .map_err(|_| REJECTED)?;
    if public.n().bits() < 2048 {
        return Err(REJECTED.into());
    }
    let signature =
        Signature::try_from(decode(&signed.signature)?.as_slice()).map_err(|_| REJECTED)?;
    VerifyingKey::<Sha256>::new(public)
        .verify(&signing_bytes(domain, &signed.payload), &signature)
        .map_err(|_| REJECTED)?;
    if started.elapsed() >= Duration::from_secs(5) || paired(root, executor, owner)? != before {
        return Err(REJECTED.into());
    }
    Ok(())
}
fn decode(value: &str) -> Result<Vec<u8>, String> {
    let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| REJECTED)?;
    if URL_SAFE_NO_PAD.encode(&bytes) != value {
        return Err(REJECTED.into());
    }
    Ok(bytes)
}
