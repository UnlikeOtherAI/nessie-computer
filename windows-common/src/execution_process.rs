//! Fixed SYSTEM process transitions. The request contains a signed selection,
//! never an executable/argument/environment supplied to the creator.
use crate::{
    custody::{valid_nonce, Generation, REJECTED},
    execution::{identifier, Admission, Descriptor, ProcessPurpose, SignedAdmission},
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryInvocation {
    pub method: String,
    pub session_id: String,
    pub raw_options: String,
}
impl HistoryInvocation {
    pub fn validate(&self, purpose: &ProcessPurpose) -> Result<(), String> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Options {
            dir: Option<String>,
            include_system_messages: Option<bool>,
            up_to_message_id: Option<String>,
        }
        let options: Options = serde_json::from_str(&self.raw_options).map_err(|_| REJECTED)?;
        let _ = options.include_system_messages;
        if !identifier(&self.session_id)
            || self.raw_options.len() > 32768
            || options
                .dir
                .as_deref()
                .is_some_and(|v| v.len() > 32768 || v.contains('\0'))
            || options
                .up_to_message_id
                .as_deref()
                .is_some_and(|v| !identifier(v))
            || !matches!(
                (purpose, self.method.as_str()),
                (ProcessPurpose::ClaudeHistoryRead, "getSessionMessages")
                    | (ProcessPurpose::ClaudeHistoryFork, "forkSession")
            )
        {
            return Err(REJECTED.into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub creator: Generation,
    pub graph: Generation,
    pub nonce: String,
    pub job_name: String,
    pub descriptor: Descriptor,
    pub admission: Admission,
    pub admission_digest: String,
    pub provider_session_id: String,
    pub command: String,
    pub image_digest: String,
    pub history_payload_digest: Option<String>,
    pub child: Option<Generation>,
    pub resumed: bool,
    pub cleared: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Frame {
        nonce: String,
        request: crate::execution_frame::Request,
    },
    Authorize {
        graph_pid: u32,
        nonce: String,
        admission: SignedAdmission,
    },
    Register {
        nonce: String,
        child_pid: u32,
        thread_handle: u64,
        stdin_handle: u64,
        stdout_handle: u64,
        output_handle: u64,
    },
    Resume {
        nonce: String,
    },
    End {
        nonce: String,
    },
    Clear {
        nonce: String,
    },
}
impl Request {
    pub fn validate(&self) -> Result<(), String> {
        let nonce = match self {
            Self::Frame { nonce, request } => {
                request.validate()?;
                nonce
            }
            Self::Authorize {
                graph_pid,
                nonce,
                admission,
            } => {
                if *graph_pid == 0
                    || admission.payload.len() > 32768
                    || admission.signature.len() > 2048
                    || !identifier(&admission.key_id)
                {
                    return Err(REJECTED.into());
                }
                nonce
            }
            Self::Register {
                nonce,
                child_pid,
                thread_handle,
                stdin_handle,
                stdout_handle,
                output_handle,
            } => {
                if *child_pid == 0
                    || *thread_handle == 0
                    || *stdin_handle == 0
                    || *stdout_handle == 0
                    || *output_handle == 0
                {
                    return Err(REJECTED.into());
                }
                nonce
            }
            Self::Clear { nonce } | Self::Resume { nonce } | Self::End { nonce } => nonce,
        };
        if !valid_nonce(nonce) {
            return Err(REJECTED.into());
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_purpose_never_changes_the_original_method() {
        let invocation = HistoryInvocation {
            method: "forkSession".into(),
            session_id: "native".into(),
            raw_options: "{}".into(),
        };
        assert!(invocation
            .validate(&ProcessPurpose::ClaudeHistoryFork)
            .is_ok());
        assert!(invocation
            .validate(&ProcessPurpose::ClaudeHistoryRead)
            .is_err());
        assert!(invocation.validate(&ProcessPurpose::Provider).is_err());
        let invalid = HistoryInvocation {
            raw_options: r#"{"command":"other.exe"}"#.into(),
            ..invocation
        };
        assert!(invalid
            .validate(&ProcessPurpose::ClaudeHistoryFork)
            .is_err());
    }
    #[test]
    fn creator_requests_have_no_raw_command_or_caller_role() {
        let base = serde_json::json!({"operation":"resume","nonce":"a".repeat(64)});
        assert!(serde_json::from_value::<Request>(base.clone())
            .unwrap()
            .validate()
            .is_ok());
        for field in ["command", "environment", "role", "approved", "childPid"] {
            let mut injected = base.clone();
            injected[field] = serde_json::json!(true);
            assert!(serde_json::from_value::<Request>(injected).is_err());
        }
    }
}
