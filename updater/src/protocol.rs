use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const UPDATER_PROTOCOL: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Stable,
    Preview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
pub enum Target {
    #[serde(rename = "windows-x64-msi")]
    WindowsX64Msi,
    #[serde(rename = "darwin-arm64-dmg")]
    DarwinArm64Dmg,
    #[serde(rename = "linux-x64-deb")]
    LinuxX64Deb,
    #[serde(rename = "linux-x64-rpm")]
    LinuxX64Rpm,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub payload: String,
    pub signature: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Asset {
    pub name: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format: u32,
    pub channel: Channel,
    pub sequence: u64,
    pub version: String,
    pub source_commit: String,
    pub published_at: String,
    pub expires_at: String,
    pub minimum_updater_protocol: u32,
    pub targets: BTreeMap<Target, Vec<Asset>>,
}

#[derive(Debug, Clone)]
pub struct VerifiedManifest {
    pub manifest: Manifest,
    pub envelope: String,
    pub digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Idle,
    Checking,
    Available,
    Downloading,
    Waiting,
    Installing,
    Restarting,
    Failed,
    Unsupported,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeenRelease {
    pub sequence: u64,
    pub digest: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingInstall {
    pub channel: Channel,
    pub envelope: String,
    pub digest: String,
    pub phase: Phase,
    pub started_at: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Status {
    pub format: u32,
    pub automatic: bool,
    pub installed_version: String,
    pub source_commit: String,
    pub channel: Channel,
    pub can_install: bool,
    pub draining: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_version: Option<String>,
    pub phase: Phase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<String>,
    pub notify: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateRequest {
    pub request_id: String,
    pub requested_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Status,
    Check,
    Install,
    Automatic { enabled: bool },
    Remind,
    Channel { channel: Channel },
    Request { request: UpdateRequest },
}
