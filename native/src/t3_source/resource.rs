use super::{handles::{chain, fail, Held, Watch}, sqlite::Database};
use crate::protocol::NativeError;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{io::{Read, Seek, SeekFrom}, path::Path, time::{Duration, Instant}};

pub struct Resource {
    // Drop SQLite before releasing any path component or sidecar handle.
    pub database: Database,
    pub description: Value,
    _chains: Vec<Held>,
    roots: [usize; 2],
    private: Vec<Held>,
    watches: Vec<Watch>,
    opened: Instant,
}

fn present(path: &Path) -> Result<bool, NativeError> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if matches!(error.raw_os_error(), Some(2 | 3)) => Ok(false),
        Err(_) => Err(fail()),
    }
}

impl Resource {
    #[cfg(test)]
    pub(super) fn expire_for_test(&mut self, opened: Instant) { self.opened = opened; }
    pub fn open(request: &Value) -> Result<Self, NativeError> {
        let state = Path::new(request["stateDirectory"].as_str().ok_or_else(fail)?);
        let mut chains = chain(state)?;
        let state_root = chains.len() - 1;
        let state = chains[state_root].path()?;
        let configuration_watch = Watch::new(&state, true)?;
        let mut config = Held::open(&state.join("executor-state.json"), false, false, true)?;
        let mut bytes = Vec::new();
        (&mut config.file).take(256 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| fail())?;
        if bytes.len() > 256 * 1024 { return Err(fail()); }
        let configuration: Value = serde_json::from_slice(&bytes).map_err(|_| fail())?;
        // The configuration file also holds executor credentials. Drop its
        // contents here; neither the source protocol nor diagnostics return it.
        let homes = configuration["t3SourceHomes"].as_array().ok_or_else(fail)?;
        if homes.len() > 128 { return Err(fail()); }
        let revision = configuration["descriptor"]["revision"].as_u64().ok_or_else(fail)?.to_string();
        let executor_id = configuration["executorId"].as_str().ok_or_else(fail)?;
        let manifest = json!({"revision":revision,"homes":homes.iter().map(|home|
            json!({"admittedRootKey":home["admittedRootKey"],"kind":home["kind"]})).collect::<Vec<_>>()});
        if request["manifest"] != manifest || request["executorId"] != executor_id { return Err(fail()); }
        let mut keys = std::collections::HashSet::new();
        for home in homes {
            let key = home["admittedRootKey"].as_str().ok_or_else(fail)?;
            if key.is_empty() || key.len() > 128 || !keys.insert(key)
                || !key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') { return Err(fail()); }
            if !["desktop-userdata", "desktop-development", "server-home", "configured-home"]
                .contains(&home["kind"].as_str().ok_or_else(fail)?) { return Err(fail()); }
        }
        let home = homes.iter().find(|home| home["admittedRootKey"] == request["admittedRootKey"])
            .ok_or_else(fail)?;
        let root = Path::new(home["stateDirectory"].as_str().ok_or_else(fail)?);
        let expected = if home["kind"] == "desktop-development" { "dev" } else { "userdata" };
        if root.file_name().and_then(|s| s.to_str()) != Some(expected) { return Err(fail()); }
        drop(config);
        let root_chain = chain(root)?;
        let root_identity = root_chain.last().ok_or_else(fail)?.identity.clone();
        let root = root_chain.last().ok_or_else(fail)?.path()?;
        chains.extend(root_chain);
        let source_root = chains.len() - 1;
        let root_watch = Watch::new(&root, false)?;
        let v2 = present(&root.join("statev2.sqlite"))?;
        let database_path = root.join(if v2 { "statev2.sqlite" } else { "state.sqlite" });
        let mut environment = Held::open(&root.join("environment-id"), false, false, true)?;
        let mut environment_bytes = Vec::new();
        (&mut environment.file).take(4097).read_to_end(&mut environment_bytes).map_err(|_| fail())?;
        if environment_bytes.len() > 4096 { return Err(fail()); }
        let environment_id = std::str::from_utf8(&environment_bytes).map_err(|_| fail())?.trim();
        if environment_id.is_empty() { return Err(fail()); }
        let environment_id = environment_id.to_owned();
        // Pin main before inspecting journal mode. A WAL connection needs the
        // existing WAL and SHM; missing sidecars refuse, never immutable=1.
        let mut main = Held::open(&database_path, false, true, true)?;
        let mut header = [0_u8; 100];
        main.file.read_exact(&mut header).map_err(|_| fail())?;
        if &header[..16] != b"SQLite format 3\0" || header[18] != header[19] { return Err(fail()); }
        let mut private = vec![environment];
        match header[18] {
            2 => {
                for suffix in ["-wal", "-shm"] {
                    private.push(Held::open(Path::new(&format!("{}{suffix}", database_path.display())), false, true, true)?);
                }
            },
            1 => {
                // A rollback database is usable only while writes are excluded
                // by Windows sharing. Existing writers make this open fail.
                let frozen = Held::open(&database_path, false, false, true)?;
                if frozen.identity != main.identity { return Err(fail()); }
                main = frozen;
                for suffix in ["-journal", "-wal", "-shm"] {
                    if present(Path::new(&format!("{}{suffix}", database_path.display())))? { return Err(fail()); }
                }
            },
            _ => return Err(fail()),
        }
        main.file.seek(SeekFrom::Start(0)).map_err(|_| fail())?;
        let database_identity = main.identity.clone();
        private.push(main);
        configuration_watch.recheck()?;
        root_watch.recheck()?;
        let database = Database::open(&database_path, v2)?;
        let source = json!({"admittedRootKey":request["admittedRootKey"],
            "physicalRootKey":format!("windows-file-id:{}", hex(&Sha256::digest(root_identity.as_bytes()))),
            "environmentId":environment_id,"layout":if v2 {"v2-80"} else {"legacy-54"},
            "databaseRole":if v2 {"authoritative-v2"} else {"sole-legacy"}});
        let result = Self { database, description: json!({"source":source,"executorId":executor_id,
            "databaseIdentity":database_identity,"environmentIdentity":private[0].identity,
            "legacyCopyProvenance":"not_attested_by_original_source"}),
            _chains:chains, roots:[state_root, source_root], private,
            watches:vec![configuration_watch, root_watch], opened:Instant::now() };
        result.recheck()?;
        Ok(result)
    }
    pub fn recheck(&self) -> Result<(), NativeError> {
        if self.opened.elapsed() >= Duration::from_secs(60) { return Err(fail()); }
        for watch in &self.watches { watch.recheck()?; }
        for held in &self.private { held.recheck()?; }
        // Roots are the last members of each chain; check all held directories'
        // identity through retained handles; owner checks apply to private roots.
        for index in self.roots { self._chains[index].recheck()?; }
        Ok(())
    }
}
pub fn hex(bytes: &[u8]) -> String { bytes.iter().map(|byte| format!("{byte:02x}")).collect() }
