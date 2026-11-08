//! Prospective consent, never a historical-author or original-copy claim.
use super::{handles::fail, resource::{hex, Resource}};
use crate::protocol::NativeError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recipient {
    pub subject: String, pub organization_id: String, pub team_id: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Scope {
    #[serde(rename = "whole_source")] WholeSource,
    #[serde(rename = "threads")] Threads {
        #[serde(rename = "threadIds")] thread_ids: Vec<String>,
        #[serde(rename = "projectIds")] project_ids: Vec<String>,
    },
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Challenge {
    pub version: u32, pub challenge_id: String, pub nonce: String, pub executor_id: String,
    pub request_id: String, pub environment_id: String, pub admitted_root_key: String, pub physical_root_key: String,
    pub database_identity: String, pub environment_identity: String, pub organization_id: String, pub team_id: String,
    pub recipient: Recipient, pub selection: Scope, pub purpose: String,
    pub grant_generation: String, pub capture_generation: String, pub accepted_baseline: String,
    pub issuer_enrollment_id: String, pub issuer_key_id: String,
    pub issued_at_ms: u64, pub expires_at_ms: u64, pub grant_expires_at_ms: u64,
}
pub fn now_ms() -> Result<u64, NativeError> {
    u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| fail())?.as_millis()).map_err(|_| fail())
}
pub fn identifier(s: &str) -> bool { !s.is_empty() && s.len() <= 256 && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') }
pub fn uuid(s: &str) -> bool {
    s.len() == 36 && s.bytes().enumerate().all(|(i,b)| match i {
        8|13|18|23 => b == b'-', 14 => (b'1'..=b'8').contains(&b), 19 => b"89ab".contains(&b),
        _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
    })
}
impl Challenge {
    pub fn validate(&self, now: u64) -> Result<(), NativeError> {
        let r = &self.recipient;
        if self.version != 1 || !uuid(&self.challenge_id) || !uuid(&self.executor_id) || !uuid(&self.grant_generation)
            || !uuid(&self.request_id) || !uuid(&self.organization_id) || !uuid(&self.team_id)
            || !uuid(&self.issuer_enrollment_id) || !hex_id(&self.issuer_key_id)
            || self.nonce.len() != 43 || !self.nonce.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || !b"AEIMQUYcgkosw048".contains(self.nonce.as_bytes().last().ok_or_else(fail)?)
            || ![&self.request_id,&self.environment_id,&self.admitted_root_key,&self.physical_root_key,
                &self.database_identity,&self.environment_identity,&self.organization_id,&self.team_id,
                &r.subject,&r.organization_id,&r.team_id,
                &self.grant_generation,&self.capture_generation].iter().all(|v| identifier(v))
            || self.purpose != "retained-import-read-publish" || self.accepted_baseline != "not_attested_by_original_source"
            || self.issued_at_ms == 0 || self.issued_at_ms > now || self.expires_at_ms <= now
            || self.expires_at_ms.saturating_sub(self.issued_at_ms) > 300_000
            || self.expires_at_ms > 9_007_199_254_740_991
            || self.grant_expires_at_ms <= now || self.grant_expires_at_ms > self.expires_at_ms { return Err(fail()); }
        if let Scope::Threads { thread_ids, project_ids } = &self.selection {
            if thread_ids.is_empty() || thread_ids.len() > 64 || !thread_ids.iter().all(|s| identifier(s))
                || thread_ids.iter().collect::<std::collections::HashSet<_>>().len() != thread_ids.len() { return Err(fail()); }
            if project_ids.len() > 64 || !project_ids.iter().all(|s| identifier(s))
                || project_ids.iter().collect::<std::collections::HashSet<_>>().len() != project_ids.len() { return Err(fail()); }
        }
        Ok(())
    }
    pub fn digest(&self) -> Result<String, NativeError> {
        let r = &self.recipient;
        let (kind, ids, projects): (&str, &[String], &[String]) = match &self.selection {
            Scope::WholeSource => ("whole_source", &[], &[]),
            Scope::Threads { thread_ids, project_ids } => ("threads", thread_ids, project_ids),
        };
        let tuple = serde_json::json!(["nessie-retained-import-challenge-v1",self.version,self.challenge_id,self.nonce,
            self.request_id,self.executor_id,self.environment_id,self.admitted_root_key,self.physical_root_key,
            self.database_identity,self.environment_identity,self.organization_id,self.team_id,
            r.subject,r.organization_id,r.team_id,kind,ids,projects,self.purpose,
            self.grant_generation,self.capture_generation,self.accepted_baseline,self.issued_at_ms,self.expires_at_ms,
            self.grant_expires_at_ms,self.issuer_enrollment_id,self.issuer_key_id]);
        Ok(hex(&Sha256::digest(serde_json::to_vec(&tuple).map_err(|_| fail())?)))
    }
    pub fn bind(&self, resource: &Resource) -> Result<(), NativeError> {
        self.validate(now_ms()?)?; resource.recheck()?;
        let d = &resource.description; let s = &d["source"];
        if d["executorId"] != self.executor_id || s["environmentId"] != self.environment_id
            || s["admittedRootKey"] != self.admitted_root_key || s["physicalRootKey"] != self.physical_root_key
            || d["databaseIdentity"] != self.database_identity || d["environmentIdentity"] != self.environment_identity {
            return Err(fail());
        }
        Ok(())
    }
}

pub fn hex_id(s: &str) -> bool { s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Verification {
    pub verification_id: String, pub nonce: String, pub issued_at_ms: u64, pub expires_at_ms: u64,
}
impl Verification {
    pub fn validate(&self, now: u64, expiry: u64) -> Result<(),NativeError> {
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
        let nonce=URL_SAFE_NO_PAD.decode(&self.nonce).map_err(|_|fail())?;
        if !uuid(&self.verification_id) || nonce.len()!=32 || URL_SAFE_NO_PAD.encode(nonce)!=self.nonce
            || self.issued_at_ms==0 || self.issued_at_ms>now || self.expires_at_ms<=now
            || self.expires_at_ms>expiry {return Err(fail());}
        Ok(())
    }
}
