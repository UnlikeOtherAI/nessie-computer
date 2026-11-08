//! Resolves only the actual OS owner's existing source registration. No daemon
//! path, service machine key, or assumed user/service enrollment equivalence.
use super::{handles::{fail, chain, Held, Watch}, resource::{Resource, configuration_bytes}, consent_contract::uuid, lease::LeaseClock};
use crate::protocol::NativeError;
use nessie_windows_common::execution_resource::{Object, Request};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{sync::{mpsc, Arc}, time::{Duration, Instant}, os::windows::{io::AsRawHandle, fs::FileExt}, path::Path};

pub(super) struct Registration {
    pub request: Value, configuration: Held, chain: Vec<Held>, source: Vec<Held>, watches: Vec<Watch>, clock: Arc<LeaseClock>,
    configuration_digest: Vec<u8>,
}
impl Registration {
pub(super) fn open(executor: &str, key: &str, clock: Arc<LeaseClock>) -> Result<Self, NativeError> {
    if !uuid(executor) || key.is_empty() || key.len() > 128
        || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') { return Err(fail()); }
    let personal = crate::personal_state_context::protected_root()?;
    let profile = personal.parent().and_then(|p| p.parent()).ok_or_else(fail)?;
    let path = profile.join(".local").join("state").join("nessie-executor").join(executor);
    Self::from_directory(&path, executor, key, clock)
}
// Private seam also used by disposable kernel-object tests. Production's only
// caller derives the directory above from the actual token, never a DTO path.
fn from_directory(path: &Path, executor: &str, key: &str, clock: Arc<LeaseClock>) -> Result<Self, NativeError> {
    let registration_chain = chain(path)?;
    let directory = registration_chain.last().ok_or_else(fail)?.path()?;
    let mut watches = vec![Watch::new(&directory, true)?, Watch::security(directory.parent().ok_or_else(fail)?)?];
    let mut configuration = Held::open(&directory.join("executor-state.json"), false, false, true)?;
    let mut bytes = configuration_bytes(&mut configuration)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| fail())?;
    let configuration_digest = Sha256::digest(&bytes).to_vec(); bytes.fill(0);
    let home = value["t3SourceHomes"].as_array().ok_or_else(fail)?.iter()
        .find(|home| home["admittedRootKey"] == key).ok_or_else(fail)?;
    let source = chain(std::path::Path::new(home["stateDirectory"].as_str().ok_or_else(fail)?))?;
    watches.push(Watch::new(&source.last().ok_or_else(fail)?.path()?, false)?);
    let request = Resource::configured_request(path, executor, key)?;
    let result = Self { request, configuration, chain: registration_chain, source, watches, clock, configuration_digest };
    result.recheck()?;
    Ok(result)
}
fn recheck(&self) -> Result<(), NativeError> {
    self.clock.check()?;
    self.configuration.recheck()?;
    // Positional reads do not share a mutable cursor with service duplicates.
    let mut bytes = vec![0; 256 * 1024 + 1];
    let mut offset = 0;
    while offset < bytes.len() {
        let count = self.configuration.file.seek_read(&mut bytes[offset..], offset as u64).map_err(|_| fail())?;
        if count == 0 { break; }
        offset += count;
    }
    let same = offset <= 256 * 1024 && Sha256::digest(&bytes[..offset]).as_slice() == self.configuration_digest.as_slice();
    bytes.fill(0);
    if !same { return Err(fail()); }
    for held in &self.chain { held.recheck_object()?; }
    self.chain.last().ok_or_else(fail)?.recheck()?;
    for held in &self.source { held.recheck_object()?; }
    self.source.last().ok_or_else(fail)?.recheck()?;
    for watch in &self.watches { watch.recheck()?; }
    self.clock.renew_after_check()
}
pub(super) fn handoff(&self, source: &Resource, configuration: &Held) -> Result<(), NativeError> {
    self.recheck()?;
    source.recheck()?;
    if configuration.identity != self.configuration.identity
        || source.execution_root()?.identity != self.source.last().ok_or_else(fail)?.identity { return Err(fail()); }
    self.recheck()
}
pub(super) fn require_link(&self, executor: &str, key: &str, review_id: &str) -> Result<(), NativeError> {
    self.recheck()?;
    let configuration = Object { handle: self.configuration.file.as_raw_handle() as usize as u64,
        identity: self.configuration.identity.clone(), kind: "configuration".into(), private: true };
    let root = self.source.last().ok_or_else(fail)?;
    let source_root = Object { handle: root.file.as_raw_handle() as usize as u64,
        identity: root.identity.clone(), kind: "source-root".into(), private: true };
    let review = super::execution_resource::service(Request::ReviewRegistration {
        executor_id: executor.into(), review_id: review_id.into(), admitted_root_key: key.into(), configuration, source_root })?;
    if review["reviewId"] != review_id || review["admittedRootKey"] != key { return Err(fail()); }
    let digest = review["reviewDigest"].as_str().ok_or_else(fail)?.to_owned();
    if review["linked"] == true { return self.recheck(); }
    if review["linked"] != false { return Err(fail()); }
    let mut display = review.clone();
    display["registrationDirectory"] = self.request["stateDirectory"].clone();
    let (caption, message) = prompt(&display)?;
    let (send, receive) = mpsc::sync_channel(1);
    // This shared primitive returns a nonconstructible AffirmedOwner only after
    // secure desktop authentication of this process's actual source-owner SID.
    std::thread::spawn(move || { let _ = send.send(crate::owner_approval_windows::affirm(caption, message)); });
    let start = Instant::now();
    let affirmation = loop {
        if start.elapsed() >= Duration::from_secs(290) { return Err(fail()); }
        self.recheck()?;
        match receive.recv_timeout(Duration::from_millis(250)) {
            Ok(result) => break result?,
            Err(mpsc::RecvTimeoutError::Timeout) => (),
            Err(_) => return Err(fail()),
        }
    };
    self.recheck()?;
    let _owner = affirmation;
    let linked = super::execution_resource::service(Request::LinkRegistration {
        executor_id: executor.into(), review_id: review_id.into(), review_digest: digest.clone() })?;
    if linked != json!({"linked":true,"reviewId":review_id,"reviewDigest":digest}) { return Err(fail()); }
    self.recheck()
}
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::test_fixture::Fixture;
    #[test]
    fn registration_holds_exact_config_and_root_across_source_handoff() {
        let fixture = Fixture::new(true);
        let clock = Arc::new(LeaseClock::new());
        let registration = Registration::from_directory(&fixture.state, "fixture", "one", clock.clone()).unwrap();
        let config = fixture.state.join("executor-state.json");
        for _ in ["review", "owner-dialog", "link", "source-open"] {
            assert!(std::fs::write(&config, "changed").is_err());
            assert!(std::fs::rename(&config, config.with_extension("replacement")).is_err());
            assert!(std::fs::rename(&fixture.root, fixture.root.with_extension("replacement")).is_err());
            registration.recheck().unwrap();
        }
        let source = Resource::open_with_clock(&registration.request, clock.clone()).unwrap();
        let configuration = source.execution_configuration().unwrap();
        registration.handoff(&source, &configuration).unwrap();
        clock.expire();
        assert!(registration.handoff(&source, &configuration).is_err());
    }
    #[test]
    fn registration_refuses_unconfigured_root_and_different_executor() {
        let fixture = Fixture::new(false);
        assert!(Registration::from_directory(&fixture.state, "fixture", "missing", Arc::new(LeaseClock::new())).is_err());
        assert!(Registration::from_directory(&fixture.state, "different", "one", Arc::new(LeaseClock::new())).is_err());
    }
}
fn prompt(review: &Value) -> Result<(String, String), NativeError> {
    #[link(name = "kernel32")]
    extern "system" { fn GetUserDefaultLocaleName(name: *mut u16, count: i32) -> i32; }
    let words: Value = serde_json::from_str(include_str!("../../../packages/executor-console/execution-source-link-words.json"))
        .map_err(|_| fail())?;
    let mut locale = [0; 85]; let count = unsafe { GetUserDefaultLocaleName(locale.as_mut_ptr(), 85) };
    let language = if count > 1 { String::from_utf16_lossy(&locale[..count as usize - 1])
        .split('-').next().unwrap_or("en").to_owned() } else { "en".into() };
    let w = words.get(&language).unwrap_or(&words["en"]);
    let details = serde_json::to_string_pretty(review).map_err(|_| fail())?.chars()
        .map(|c| if c.is_ascii() { c.to_string() } else { format!("\\u{{{:x}}}", c as u32) }).collect::<String>();
    let message = format!("{}\n\n{}", w["message"].as_str().ok_or_else(fail)?, details);
    if message.encode_utf16().count() > 32_766 { return Err(fail()); }
    Ok((w["caption"].as_str().ok_or_else(fail)?.into(), message))
}
