//! Crash-durable public fences outside pairing directories; never credential bytes.
use crate::custody::{Generation, Record, REJECTED, VERSION};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fence {
    pub owner_sid: String,
    pub controller: Generation,
    pub revoked: bool,
    pub clear_requested: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Host {
    pub owner_sid: String,
    pub controller: Generation,
    pub runtime_child: Generation,
    pub job_name: String,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    pub version: u32,
    pub runtimes: BTreeMap<String, Record>,
    pub fences: BTreeMap<String, Fence>,
    pub hosts: BTreeMap<String, Host>,
    #[serde(default)]
    pub holds: BTreeMap<String, Generation>,
    #[serde(default)]
    pub execution_creations: BTreeMap<String, crate::execution_creator::Creation>,
    #[serde(default)]
    pub execution_processes: BTreeMap<String, crate::execution_process::Record>,
}
pub struct Store {
    path: PathBuf,
}
impl State {
    pub fn begin_inventory(
        &mut self,
        owner: &str,
        controller: Generation,
        nonce: &str,
    ) -> Result<String, String> {
        if self.holds.contains_key(nonce)
            || self
                .fences
                .values()
                .any(|fence| fence.owner_sid != owner || fence.revoked)
        {
            return Err(REJECTED.into());
        }
        let epoch = self
            .fences
            .iter()
            .find(|(_, fence)| fence.owner_sid == owner)
            .map(|(epoch, _)| epoch.clone())
            .unwrap_or_else(|| nonce.to_owned());
        self.fences.entry(epoch.clone()).or_insert(Fence {
            owner_sid: owner.to_owned(),
            controller: controller.clone(),
            revoked: false,
            clear_requested: false,
        });
        self.holds.insert(nonce.to_owned(), controller);
        Ok(epoch)
    }
}
impl Store {
    pub fn new(root: &Path) -> Self {
        Self {
            path: root.join("custody").join("machine.json"),
        }
    }
    pub fn read(&self) -> Result<State, String> {
        let entry = match fs::symlink_metadata(&self.path) {
            Ok(entry) => entry,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(State {
                    version: VERSION,
                    ..State::default()
                })
            }
            Err(_) => return Err(REJECTED.into()),
        };
        if !entry.is_file() || entry.file_type().is_symlink() || entry.len() > 1_048_576 {
            return Err(REJECTED.into());
        }
        let file = OpenOptions::new()
            .read(true)
            .open(&self.path)
            .map_err(|_| REJECTED)?;
        let mut bytes = Vec::new();
        file.take(1_048_577)
            .read_to_end(&mut bytes)
            .map_err(|_| REJECTED)?;
        let state: State = serde_json::from_slice(&bytes).map_err(|_| REJECTED)?;
        if state.version != VERSION
            || state.runtimes.len() > 256
            || state.fences.len() > 256
            || state.hosts.len() > 4096
            || state.holds.len() > 256
            || state.execution_creations.len() > 256
            || state.execution_processes.len() > 256
        {
            return Err(REJECTED.into());
        }
        Ok(state)
    }
    pub fn write(&self, state: &State) -> Result<(), String> {
        let encoded=serde_json::to_vec(state).map_err(|_|REJECTED)?;
        if encoded.len()>1_048_576{return Err(REJECTED.into());}
        let parent = self.path.parent().ok_or(REJECTED)?;
        fs::create_dir_all(parent).map_err(|_| REJECTED)?;
        let draft = self.path.with_extension("draft");
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&draft)
            .map_err(|_| REJECTED)?;
        file.write_all(&encoded)
            .map_err(|_| REJECTED)?;
        file.sync_all().map_err(|_| REJECTED)?;
        drop(file);
        replace(&draft, &self.path)
    }
}
#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(REJECTED.into());
    }
    Ok(())
}
#[cfg(not(windows))]
fn replace(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|_| REJECTED.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_inventory_reuses_one_owner_epoch_and_separates_probe_lifetime() {
        let mut state = State {
            version: VERSION,
            ..State::default()
        };
        let actor = Generation {
            pid: 42,
            started_at: "123".into(),
            boot_id: "boot".into(),
        };
        let first = "a".repeat(64);
        let second = "b".repeat(64);
        assert_eq!(
            state
                .begin_inventory("S-1-5-21-123", actor.clone(), &first)
                .unwrap(),
            first
        );
        state.holds.remove(&first);
        assert_eq!(
            state
                .begin_inventory("S-1-5-21-123", actor.clone(), &second)
                .unwrap(),
            first
        );
        assert_eq!(state.fences.len(), 1);
        assert_eq!(state.holds.len(), 1);
        assert!(state
            .begin_inventory("S-1-5-21-999", actor.clone(), &"c".repeat(64))
            .is_err());
        state.fences.get_mut(&first).unwrap().revoked = true;
        assert!(state
            .begin_inventory("S-1-5-21-123", actor, &"d".repeat(64))
            .is_err());
    }
    #[test]
    fn revocation_survives_restart_and_pairing_removal() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::new(root.path());
        let mut state = store.read().unwrap();
        state.fences.insert(
            "a".repeat(64),
            Fence {
                owner_sid: "S-1-5-21-123".into(),
                controller: Generation {
                    pid: 42,
                    started_at: "123".into(),
                    boot_id: "boot".into(),
                },
                revoked: true,
                clear_requested: false,
            },
        );
        store.write(&state).unwrap();
        let pairing = root.path().join("executors");
        fs::create_dir(&pairing).unwrap();
        fs::remove_dir(&pairing).unwrap();
        assert!(Store::new(root.path())
            .read()
            .unwrap()
            .fences
            .values()
            .all(|fence| fence.revoked));
    }
    #[test]
    fn malformed_existing_custody_never_resets_to_empty() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("custody")).unwrap();
        fs::write(root.path().join("custody/machine.json"), b"invalid").unwrap();
        assert!(Store::new(root.path()).read().is_err());
    }
}
