//! Execution-only settings. Nothing in the retained source dispatcher calls this.
use super::{handles::{fail, chain, Held, Watch}, resource::hex, consent_state::random_id};
use crate::protocol::NativeError;
use nessie_windows_common::execution_resource::{Object, ProviderReference, SETTINGS_LIMIT};
use sha2::{Digest, Sha256};
use std::{io::{Read, Seek, SeekFrom}, os::windows::io::AsRawHandle, path::Path};

pub struct Settings {
    file: Held,
    bytes: Vec<u8>,
    digest: String,
    homes: Vec<Vec<Held>>,
    watches: Vec<Watch>,
    references: Vec<ProviderReference>,
}
impl Settings {
    pub fn open(root: &Held) -> Result<Self, NativeError> {
        root.recheck()?;
        let root_path = root.path()?;
        let watch = Watch::new(&root_path, false)?;
        let mut file = Held::open(&root_path.join("settings.json"), false, false, true)?;
        let mut bytes = Vec::new();
        (&mut file.file).take(SETTINGS_LIMIT as u64 + 1).read_to_end(&mut bytes).map_err(|_| fail())?;
        if bytes.is_empty() || bytes.len() > SETTINGS_LIMIT { return Err(fail()); }
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| fail())?;
        if !value.is_object() { return Err(fail()); }
        let digest = hex(&Sha256::digest(&bytes));
        let mut result = Self { file, bytes, digest, homes: Vec::new(), watches: vec![watch], references: Vec::new() };
        // Only explicit original driver home fields are candidates. Defaults,
        // inherited environment, ~ and relative paths require separate local
        // enrollment, not an inference from a continuationIdentity string.
        if let Some(instances) = value.get("providerInstances") {
            let instances = instances.as_object().ok_or_else(fail)?;
            if instances.len() > 64 { return Err(fail()); }
            for (id, instance) in instances {
                if instance["enabled"] == false { continue; }
                let driver = instance["driver"].as_str().ok_or_else(fail)?;
                if !["codex", "claude"].contains(&driver) { continue; }
                let config = &instance["config"];
                if config["enabled"] == false || config["setupMode"] == "managed" { continue; }
                let Some(home) = config["homePath"].as_str().filter(|s| !s.trim().is_empty()) else { continue; };
                let history = result.hold_home(home.trim())?;
                let credential = match config["shadowHomePath"].as_str().filter(|s| !s.trim().is_empty()) {
                    Some(shadow) if driver == "codex" => result.hold_home(shadow.trim())?,
                    _ => history.clone(),
                };
                for (role, identity) in [("history", history.clone()), ("continuation", history), ("credential", credential)] {
                    result.references.push(ProviderReference { reference_id: random_id()?, instance_id: id.clone(),
                        driver: driver.to_owned(), role: role.to_owned(), identity });
                }
            }
        }
        result.recheck()?;
        Ok(result)
    }
    fn hold_home(&mut self, path: &str) -> Result<String, NativeError> {
        let held = chain(Path::new(path))?;
        let last = held.last().ok_or_else(fail)?;
        let identity = last.identity.clone();
        // Provider writes are allowed inside the directory; its namespace and
        // ACL remain pinned. Inspect never opens a credential/history child.
        self.watches.push(Watch::security(&last.path()?)?);
        self.homes.push(held);
        Ok(identity)
    }
    pub fn recheck(&self) -> Result<(), NativeError> {
        for watch in &self.watches { watch.recheck()?; }
        self.file.recheck()?;
        for home in &self.homes {
            for part in home { part.recheck_object()?; }
            home.last().ok_or_else(fail)?.recheck()?;
        }
        Ok(())
    }
    pub fn bytes(&mut self) -> Result<&[u8], NativeError> {
        self.recheck()?;
        self.file.file.seek(SeekFrom::Start(0)).map_err(|_| fail())?;
        let mut observed = Vec::new();
        (&mut self.file.file).take(SETTINGS_LIMIT as u64 + 1).read_to_end(&mut observed).map_err(|_| fail())?;
        if observed != self.bytes { return Err(fail()); }
        self.recheck()?;
        Ok(&self.bytes)
    }
    pub fn identity(&self) -> &str { &self.file.identity }
    pub fn digest(&self) -> &str { &self.digest }
    pub fn length(&self) -> usize { self.bytes.len() }
    pub fn references(&self) -> &[ProviderReference] { &self.references }
    pub fn watches(&self) -> Vec<u64> { self.watches.iter().map(Watch::raw).collect() }
    pub fn objects(&self) -> Vec<Object> {
        let object = |held: &Held, kind: &str, private| Object { handle: held.file.as_raw_handle() as usize as u64,
            identity: held.identity.clone(), kind: kind.to_owned(), private };
        let mut objects = vec![object(&self.file, "settings", true)];
        for home in &self.homes {
            for (i, held) in home.iter().enumerate() {
                let last = i == home.len() - 1;
                objects.push(object(held, if last { "provider-home" } else { "directory" }, last));
            }
        }
        objects
    }
}
impl Drop for Settings { fn drop(&mut self) { self.bytes.fill(0); } }
