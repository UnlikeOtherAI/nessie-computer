//! Preserve obsolete host-admission evidence before removing its active authority.
//! The service alone selects controllers independently proved ended under admission.
use super::{Host, State, Store};
use crate::custody::REJECTED;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs::{self, OpenOptions}, io::{Read, Write}};

impl Store {
    pub fn retire_hosts(&self, state: &mut State, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() { return Ok(()); }
        let hosts: BTreeMap<&String, &Host> = ids.iter().map(|id| {
            state.hosts.get(id).map(|host| (id, host)).ok_or(REJECTED)
        }).collect::<Result<_, _>>()?;
        let bytes = serde_json::to_vec(&serde_json::json!({
            "version": 1, "reason": "host-execution-fence-retired", "hosts": hosts,
        })).map_err(|_| REJECTED)?;
        if bytes.len() > 1_048_576 { return Err(REJECTED.into()); }
        let directory = self.path.parent().ok_or(REJECTED)?.join("retired-host-admissions");
        match fs::create_dir(&directory) {
            Ok(()) => {},
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
            Err(_) => return Err(REJECTED.into()),
        }
        let metadata = fs::symlink_metadata(&directory).map_err(|_| REJECTED)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err(REJECTED.into()); }
        let path = directory.join(format!("{:x}.json", Sha256::digest(&bytes)));
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if !metadata.is_file() || metadata.file_type().is_symlink()
                    || metadata.len() != bytes.len() as u64 { return Err(REJECTED.into()); }
                let mut existing = Vec::new();
                fs::File::open(&path).map_err(|_| REJECTED)?.take(1_048_577)
                    .read_to_end(&mut existing).map_err(|_| REJECTED)?;
                if existing != bytes { return Err(REJECTED.into()); }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let draft = path.with_extension("draft");
                if fs::symlink_metadata(&draft).is_ok_and(|entry| !entry.is_file()
                    || entry.file_type().is_symlink()) { return Err(REJECTED.into()); }
                let mut file = OpenOptions::new().write(true).create(true).truncate(true)
                    .open(&draft).map_err(|_| REJECTED)?;
                file.write_all(&bytes).map_err(|_| REJECTED)?;
                file.sync_all().map_err(|_| REJECTED)?;
                drop(file);
                super::replace(&draft, &path).map_err(|_| REJECTED)?;
            },
            Err(_) => return Err(REJECTED.into()),
        }
        for id in ids { state.hosts.remove(id); }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custody::{Generation, VERSION};

    fn state() -> State {
        let process = Generation { pid: 42, started_at: "123".into(), boot_id: "boot".into() };
        let mut state = State { version: VERSION, ..State::default() };
        state.hosts.insert("a".repeat(64), Host { owner_sid: "owner".into(),
            controller: process.clone(), runtime_child: process, job_name: "job".into() });
        state
    }

    #[test]
    fn an_archive_survives_and_replays_after_a_crash_before_journal_write() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::new(root.path());
        let mut current = state();
        store.write(&current).unwrap();
        let ids = vec!["a".repeat(64)];
        store.retire_hosts(&mut current, &ids).unwrap();
        assert!(current.hosts.is_empty());
        let mut after_crash = store.read().unwrap();
        assert_eq!(after_crash.hosts.len(), 1, "the original journal still contains the evidence");
        store.retire_hosts(&mut after_crash, &ids).unwrap();
        store.write(&after_crash).unwrap();
        assert!(store.read().unwrap().hosts.is_empty());
        let archives = fs::read_dir(root.path().join("custody/retired-host-admissions"))
            .unwrap().collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(archives.len(), 1);
        let archived: serde_json::Value = serde_json::from_slice(&fs::read(archives[0].path()).unwrap()).unwrap();
        assert_eq!(archived["hosts"], serde_json::to_value(state().hosts).unwrap());
    }

    #[test]
    fn an_unwritable_archive_preserves_every_active_record() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::new(root.path());
        let mut current = state();
        store.write(&current).unwrap();
        fs::write(root.path().join("custody/retired-host-admissions"), b"occupied").unwrap();
        assert!(store.retire_hosts(&mut current, &["a".repeat(64)]).is_err());
        assert_eq!(current.hosts.len(), 1);
        assert_eq!(store.read().unwrap().hosts.len(), 1);
    }
}
