#[cfg(unix)]
use serde::Deserialize;
use serde::Serialize;
#[cfg(unix)]
use std::io;

/// The workspace-promotion protocol below is POSIX-only: it acts on inherited
/// directory descriptors, which Windows has no equivalent for. Only the state
/// -security commands and the response shapes are shared by every host.
#[cfg(unix)]
pub const PROTOCOL_VERSION: u8 = 1;
#[cfg(unix)]
pub const MAX_CHANGES: usize = 100;
pub const MAX_PATH_LENGTH: usize = 1024;
#[cfg(unix)]
pub const MAX_REQUEST_BYTES: u64 = 128 * 1024;

#[cfg(unix)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DigestEntry {
    pub byte_count: u64,
    pub digest: String,
}

#[cfg(unix)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Created,
    Modified,
    Deleted,
}

#[cfg(unix)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub base: Option<DigestEntry>,
    pub draft: Option<DigestEntry>,
    pub kind: ChangeKind,
    pub path: String,
}

#[cfg(unix)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreflightRequest {
    pub changes: Vec<Change>,
    pub manifest_digest: String,
    pub protocol_version: u8,
    pub run_id: String,
}

/// The approval and fence are server-authored command facts. The native helper
/// records them in its durable journal but deliberately cannot mint or verify
/// either: only the companion can call it after verifying the signed command.
#[cfg(unix)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromotionRequest {
    pub approval_digest: String,
    pub binding_fence: String,
    pub changes: Vec<Change>,
    pub manifest_digest: String,
    pub promotion_id: String,
    pub protocol_version: u8,
    pub run_id: String,
}

#[cfg(unix)]
impl PromotionRequest {
    pub fn manifest(&self) -> PreflightRequest {
        PreflightRequest {
            changes: self.changes.clone(),
            manifest_digest: self.manifest_digest.clone(),
            protocol_version: self.protocol_version,
            run_id: self.run_id.clone(),
        }
    }
}

#[cfg_attr(not(unix), allow(dead_code))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PreflightStatus {
    Ready,
    Rejected,
}

#[cfg_attr(not(unix), allow(dead_code))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PromotionStatus {
    Applied,
    Rejected,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreflightResponse {
    pub code: Option<String>,
    pub manifest_digest: String,
    pub run_id: String,
    pub status: PreflightStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StateSecurityStatus {
    Secured,
    Verified,
    Rejected,
}

/// The state-security answer carries a verdict and, when it refuses, a code —
/// never the path it was asked about, and never an operating-system message.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateSecurityResponse {
    pub code: Option<String>,
    pub status: StateSecurityStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobRunStatus {
    Rejected,
}

/// `job-run` answers only when it refuses: a program it did start owns stdout
/// and the exit code, so this line goes to stderr, where the executor keeps
/// the agent's own diagnostics, and the helper exits with
/// `JOB_RUN_REFUSED_EXIT_CODE`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobRunResponse {
    pub code: Option<String>,
    pub status: JobRunStatus,
}

/// The exit code of a `job-run` that ran nothing, or whose containment failed
/// before the program could run uncontained. It is the code `env` and
/// container runtimes use for "the wrapper itself failed".
pub const JOB_RUN_REFUSED_EXIT_CODE: i32 = 125;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromotionResponse {
    pub code: Option<String>,
    pub manifest_digest: String,
    pub promotion_id: String,
    pub run_id: String,
    pub status: PromotionStatus,
}

#[derive(Debug)]
pub struct NativeError {
    pub code: &'static str,
}

impl NativeError {
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }
}

#[cfg(unix)]
impl From<io::Error> for NativeError {
    fn from(_: io::Error) -> Self {
        Self::new("EXECUTOR_PROMOTION_IO_FAILURE")
    }
}
