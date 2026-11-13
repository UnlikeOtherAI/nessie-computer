//! One complete original-serializer frame. Metadata never grants its own write.
use crate::{
    custody::{valid_nonce, Generation, REJECTED},
    execution::{digest, identifier, Binding, SignedAdmission},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub const DOMAIN: &str = "nessie.t3.execution.frame.v1";
pub const PREPARATION_DOMAIN: &str = "nessie.t3.execution.frame-preparation.v1";
pub const MAX: usize = 131072;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Context {
    pub correlation_id: String,
    pub command_id: String,
    pub request_digest: String,
    pub provider_session_id: String,
}
impl Context {
    pub fn matches(&self, binding: &Binding, session: &str) -> bool {
        self.correlation_id == binding.correlation_id
            && self.command_id == binding.command_id
            && self.request_digest == binding.relay_hmac
            && self.provider_session_id == session
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Frame {
    pub driver: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_id: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    pub frame_sha256: String,
}
impl Frame {
    pub fn validate(&self) -> Result<(), String> {
        if !["codex", "claude"].contains(&self.driver.as_str())
            || !["request", "notification", "response", "cancel", "message"]
                .contains(&self.kind.as_str())
            || !digest(&self.frame_sha256)
            || self.protocol_id.as_ref().is_some_and(|v| !protocol_id(v))
            || self.message_id.as_deref().is_some_and(|v| !identifier(v))
            || self.method.as_deref().is_some_and(|v| !identifier(v))
        {
            return Err(REJECTED.into());
        }
        Ok(())
    }
}
pub fn protocol_id(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| !s.is_empty() && s.len() <= 512 && !s.contains('\0'))
        || value
            .as_i64()
            .is_some_and(|n| (-9007199254740991..=9007199254740991).contains(&n))
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Admission {
    pub version: u32,
    pub reservation_id: String,
    pub frame_id: String,
    pub binding: Binding,
    pub provider_session_id: String,
    pub launch_digest: String,
    pub process_purpose: String,
    pub child: Generation,
    pub frame: Frame,
    pub nonce: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub issuer_key_id: String,
    pub release_digest: String,
    pub frame_receipt_digest: String,
}
impl Admission {
    pub fn validate(&self, now: u64) -> Result<(), String> {
        self.binding.validate(false)?;
        self.frame.validate()?;
        if self.version != 1
            || self.process_purpose != "provider"
            || self.frame.driver != self.binding.driver
            || ![
                &self.reservation_id,
                &self.frame_id,
                &self.nonce,
                &self.issuer_key_id,
                &self.release_digest,
            ]
            .into_iter()
            .all(|s| valid_nonce(s))
            || !identifier(&self.provider_session_id)
            || !digest(&self.launch_digest)
            || !digest(&self.frame_receipt_digest)
            || self.child.pid == 0
            || !identifier(&self.child.started_at)
            || !identifier(&self.child.boot_id)
            || self.expires_at_ms <= now
            || self.issued_at_ms > now
            || self.expires_at_ms <= self.issued_at_ms
            || self.expires_at_ms - self.issued_at_ms > 5000
        {
            return Err(REJECTED.into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Begin {
        context: Context,
        frame: Frame,
        byte_length: u32,
    },
    Append {
        frame_id: String,
        offset: u32,
        data: String,
    },
    Prepare {
        frame_id: String,
    },
    Stage {
        frame_id: String,
    },
    Commit {
        admission: SignedAdmission,
    },
    CommitEffect {
        frame_id: String,
        proof: crate::execution_effect::Proof,
    },
    AutomaticReply {
        protocol_id: Value,
    },
}
impl Request {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Begin {
                context,
                frame,
                byte_length,
            } => {
                frame.validate()?;
                if *byte_length == 0
                    || *byte_length as usize > MAX
                    || !identifier(&context.correlation_id)
                    || !identifier(&context.command_id)
                    || !identifier(&context.provider_session_id)
                    || !context
                        .request_digest
                        .strip_prefix("hmac-sha256:")
                        .is_some_and(valid_nonce)
                {
                    return Err(REJECTED.into());
                }
            }
            Self::Append {
                frame_id,
                offset,
                data,
            } => {
                if !valid_nonce(frame_id)
                    || *offset as usize > MAX
                    || data.is_empty()
                    || data.len() > 24000
                {
                    return Err(REJECTED.into());
                }
            }
            Self::Prepare { frame_id } | Self::Stage { frame_id } => {
                if !valid_nonce(frame_id) {
                    return Err(REJECTED.into());
                }
            }
            Self::CommitEffect { frame_id, proof } => {
                if !valid_nonce(frame_id)
                    || !identifier(&proof.key_id)
                    || proof.signature.len() > 2048
                {
                    return Err(REJECTED.into());
                }
                proof.grant.validate(crate::execution::now_ms()?)?;
            }
            Self::AutomaticReply { protocol_id: id } => {
                if !protocol_id(id) {
                    return Err(REJECTED.into());
                }
            }
            Self::Commit { admission } => {
                if admission.payload.len() > 32768
                    || admission.signature.len() > 2048
                    || !identifier(&admission.key_id)
                {
                    return Err(REJECTED.into());
                }
            }
        };
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_reference_cannot_inject_authority_or_multiple_frames() {
        let request = serde_json::json!({"operation":"prepare","frameId":"a".repeat(64)});
        assert!(serde_json::from_value::<Request>(request.clone())
            .unwrap()
            .validate()
            .is_ok());
        for field in [
            "admission",
            "bytes",
            "approved",
            "nativeId",
            "providerSessionId",
        ] {
            let mut forged = request.clone();
            forged[field] = serde_json::json!(true);
            assert!(serde_json::from_value::<Request>(forged).is_err());
        }
        assert!(Request::Append {
            frame_id: "a".repeat(64),
            offset: MAX as u32 + 1,
            data: "eA==".into()
        }
        .validate()
        .is_err());
    }
    #[test]
    fn automatic_reply_accepts_an_id_only() {
        let request = serde_json::json!({"operation":"automaticReply","protocolId":"provider-42"});
        assert!(serde_json::from_value::<Request>(request.clone())
            .unwrap()
            .validate()
            .is_ok());
        let mut injected = request;
        injected["response"] = serde_json::json!({"approved":true});
        assert!(serde_json::from_value::<Request>(injected).is_err());
        assert!(Request::AutomaticReply {
            protocol_id: serde_json::json!({"id":1})
        }
        .validate()
        .is_err());
    }
}
