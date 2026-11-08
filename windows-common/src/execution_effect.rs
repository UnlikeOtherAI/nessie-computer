//! Same signed finite effect envelope used by the enrolled backend client.
use crate::{
    custody::REJECTED,
    execution::{digest, identifier},
};
use serde::{Deserialize, Serialize};
pub const DOMAIN: &str = "nessie.executor.t3.effect-grant.v1";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Association {
    pub driver: String,
    pub native_id: String,
    pub continuation_home_key: String,
    pub history_home_key: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Grant {
    pub kind: String,
    pub version: u32,
    pub purpose: String,
    pub executor_id: String,
    pub environment_id: String,
    pub thread_id: String,
    pub provider_session_id: String,
    pub connection_epoch: String,
    pub runtime_generation: String,
    pub correlation_id: String,
    pub command_id: String,
    pub request_digest: String,
    pub native_association: Association,
    pub issued_at: String,
    pub expires_at: String,
    pub request_nonce: String,
    pub request_proof_digest: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proof {
    pub grant: Grant,
    pub key_id: String,
    pub signature: String,
}
impl Grant {
    pub fn validate(&self, now: u64) -> Result<u64, String> {
        let issued = timestamp(&self.issued_at)?;
        let expires = timestamp(&self.expires_at)?;
        if self.kind != "t3-effect"
            || self.version != 1
            || self.purpose != "execute"
            || issued > now
            || expires <= now
            || expires <= issued
            || expires - issued > 5000
            || !digest(&self.request_proof_digest)
            || !self
                .request_digest
                .strip_prefix("hmac-sha256:")
                .is_some_and(crate::custody::valid_nonce)
            || ![
                &self.executor_id,
                &self.environment_id,
                &self.thread_id,
                &self.provider_session_id,
                &self.connection_epoch,
                &self.runtime_generation,
                &self.correlation_id,
                &self.command_id,
                &self.native_association.native_id,
                &self.native_association.continuation_home_key,
                &self.native_association.history_home_key,
            ]
            .into_iter()
            .all(|v| identifier(v))
            || !["codex", "claude"].contains(&self.native_association.driver.as_str())
            || !uuid(&self.request_nonce)
        {
            return Err(REJECTED.into());
        }
        Ok(expires)
    }
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
/// Backend emits Date.toISOString(), always exact UTC milliseconds. No locale,
/// floating point, guessed timezone or normalization of invalid dates.
pub fn timestamp(value: &str) -> Result<u64, String> {
    let b = value.as_bytes();
    if b.len() != 24
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[19] != b'.'
        || b[23] != b'Z'
    {
        return Err(REJECTED.into());
    }
    let number = |start: usize, len: usize| -> Result<u64, String> {
        if !b[start..start + len].iter().all(u8::is_ascii_digit) {
            return Err(REJECTED.into());
        }
        Ok(b[start..start + len]
            .iter()
            .fold(0, |n, b| n * 10 + (b - b'0') as u64))
    };
    let (year, month, day) = (number(0, 4)?, number(5, 2)?, number(8, 2)?);
    let (hour, minute, second, millis) = (
        number(11, 2)?,
        number(14, 2)?,
        number(17, 2)?,
        number(20, 3)?,
    );
    let leap = |y: u64| y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let months = [
        31,
        if leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if year < 1970
        || !(1..=12).contains(&month)
        || day == 0
        || day > months[(month - 1) as usize]
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(REJECTED.into());
    }
    let days = (1970..year)
        .map(|y| if leap(y) { 366 } else { 365 })
        .sum::<u64>()
        + months[..(month - 1) as usize].iter().sum::<u64>()
        + day
        - 1;
    Ok((((days * 24 + hour) * 60 + minute) * 60 + second) * 1000 + millis)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn effect_is_expired_at_boundary_and_cannot_extend_lifetime() {
        let mut grant:Grant=serde_json::from_value(serde_json::json!({
            "kind":"t3-effect","version":1,"purpose":"execute","executorId":"executor","environmentId":"environment",
            "threadId":"thread","providerSessionId":"session","connectionEpoch":"1","runtimeGeneration":"runtime",
            "correlationId":"operation","commandId":"command","requestDigest":format!("hmac-sha256:{}","a".repeat(64)),
            "nativeAssociation":{"driver":"codex","nativeId":"native","continuationHomeKey":"continuation","historyHomeKey":"history"},
            "issuedAt":"2026-11-08T12:00:00.000Z","expiresAt":"2026-11-08T12:00:05.000Z",
            "requestNonce":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","requestProofDigest":format!("sha256:{}","b".repeat(64))
        })).unwrap();
        let start = timestamp(&grant.issued_at).unwrap();
        assert!(grant.validate(start).is_ok());
        assert!(grant.validate(start + 4999).is_ok());
        assert!(grant.validate(start + 5000).is_err());
        grant.expires_at = "2026-11-08T12:00:05.001Z".into();
        assert!(grant.validate(start).is_err());
        grant.expires_at = grant.issued_at.clone();
        assert!(grant.validate(start).is_err());
    }
    #[test]
    fn strict_utc_and_leap_boundaries() {
        assert_eq!(timestamp("1970-01-01T00:00:00.000Z").unwrap(), 0);
        assert_eq!(
            timestamp("2000-03-01T00:00:00.000Z").unwrap()
                - timestamp("2000-02-28T00:00:00.000Z").unwrap(),
            172800000
        );
        for invalid in [
            "2026-02-29T00:00:00.000Z",
            "2026-01-01T24:00:00.000Z",
            "2026-01-01T00:00:60.000Z",
            "2026-01-01T00:00:00.000+01:00",
        ] {
            assert!(timestamp(invalid).is_err());
        }
    }
}
