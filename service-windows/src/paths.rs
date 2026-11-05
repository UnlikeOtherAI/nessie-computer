//! Where the service keeps things, and who is allowed to ask it anything.
//!
//! Pairing material and machine keys belong to the service account, not to a
//! person's profile, so everything lives under
//! `%ProgramData%\Nessie Executor\`:
//!
//! | Path | What it holds |
//! | --- | --- |
//! | `executors\<executorId>\` | one paired executor's state, its daemon lease, and `paired-by.sid` |
//! | `pending\<enrollmentId>\` | a pairing in flight; the API names the executor id, so the directory can only be named after it succeeds |
//! | `control-clients\<sid>` | a marker naming one account the control pipe admits |
//! | `logs\` | the folder the tray's **Open logs folder** opens |
//!
//! The root is created and proved owner-only through the packaged native
//! helper, so its DACL is the service account plus SYSTEM and nothing else.
//!
//! The functions take a root rather than reading the environment, so both the
//! layout and the enumeration rules are exercised on any host.

use std::{
    fs,
    path::{Path, PathBuf},
};

use nessie_windows_common::{
    is_sid_string, CONTROL_CLIENTS_DIRECTORY, LOGS_DIRECTORY, SERVICE_DIRECTORY_NAME,
};

use crate::protocol::valid_identifier;

pub const EXECUTOR_STATE_FILE: &str = "executor-state.json";

/// The account recorded when this executor was paired. It is one line: a SID in
/// its string form.
pub const PAIRED_BY_FILE: &str = "paired-by.sid";

/// `%ProgramData%` is set for every service process; a host that does not report
/// it is not one this service can lay its state down on, and guessing a path
/// there would put pairing material somewhere nobody audited.
pub fn service_root() -> Result<PathBuf, String> {
    let program_data = std::env::var_os("ProgramData")
        .ok_or_else(|| "Windows reported no ProgramData directory.".to_owned())?;
    Ok(PathBuf::from(program_data).join(SERVICE_DIRECTORY_NAME))
}

pub fn executors_root(root: &Path) -> PathBuf {
    root.join("executors")
}

pub fn pending_root(root: &Path) -> PathBuf {
    root.join("pending")
}

pub fn control_clients_root(root: &Path) -> PathBuf {
    root.join(CONTROL_CLIENTS_DIRECTORY)
}

pub fn logs_root(root: &Path) -> PathBuf {
    root.join(LOGS_DIRECTORY)
}

/// The state directory for one paired executor. The id is validated because it
/// becomes a path segment.
pub fn executor_state_dir(root: &Path, executor_id: &str) -> Result<PathBuf, String> {
    if !valid_identifier(executor_id) {
        return Err("The executor id is malformed.".to_owned());
    }
    Ok(executors_root(root).join(executor_id))
}

/// An ordinary directory holding an ordinary state file. A symlink at either
/// level is refused rather than followed: the state root is owner-only, but a
/// link inside it would still reach outside it.
pub fn has_executor_state(state_dir: &Path) -> bool {
    let directory = fs::symlink_metadata(state_dir);
    let state = fs::symlink_metadata(state_dir.join(EXECUTOR_STATE_FILE));
    matches!(directory, Ok(ref entry) if entry.is_dir() && !entry.file_type().is_symlink())
        && matches!(state, Ok(ref entry) if entry.is_file() && !entry.file_type().is_symlink())
}

/// Every paired executor, in a stable order so the tray's menu does not
/// reshuffle between polls.
pub fn paired_executors(root: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(executors_root(root)) else {
        return Vec::new();
    };
    let mut paired: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let state_dir = entry.path();
            (valid_identifier(&name) && has_executor_state(&state_dir)).then_some(name)
        })
        .collect();
    paired.sort();
    paired
}

/// The accounts the control pipe admits, besides Administrators: every account
/// an elevated grant recorded, plus every account that has paired an executor.
/// Both are written only with administrative rights, which is what makes this
/// list an authorization rather than a hint.
pub fn control_client_sids(root: &Path) -> Vec<String> {
    let mut sids: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(control_clients_root(root)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_sid_string(&name) {
                sids.push(name);
            }
        }
    }
    for executor_id in paired_executors(root) {
        let path = executors_root(root).join(executor_id).join(PAIRED_BY_FILE);
        if let Ok(recorded) = fs::read_to_string(path) {
            let recorded = recorded.trim().to_owned();
            if is_sid_string(&recorded) {
                sids.push(recorded);
            }
        }
    }
    sids.sort();
    sids.dedup();
    sids
}

#[cfg(test)]
mod tests {
    use super::{
        control_client_sids, executor_state_dir, has_executor_state, paired_executors,
        EXECUTOR_STATE_FILE, PAIRED_BY_FILE,
    };
    use std::fs;

    const SID: &str = "S-1-5-21-1004336348-1177238915-682003330-1001";

    fn pair_executor(root: &std::path::Path, executor_id: &str) {
        let state_dir = root.join("executors").join(executor_id);
        fs::create_dir_all(&state_dir).expect("the state directory must be creatable");
        fs::write(state_dir.join(EXECUTOR_STATE_FILE), b"{}").expect("state");
    }

    #[test]
    fn an_executor_id_becomes_a_path_segment_only_when_it_is_safe() {
        let root = std::path::Path::new("/service-root");
        assert_eq!(
            executor_state_dir(root, "00000000-0000-4000-8000-000000000001").unwrap(),
            root.join("executors").join("00000000-0000-4000-8000-000000000001"),
        );
        for malformed in ["..", "../elsewhere", "a/b", ""] {
            assert!(executor_state_dir(root, malformed).is_err(), "{malformed:?} must be refused");
        }
    }

    #[test]
    fn a_directory_without_paired_state_is_not_a_paired_executor() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let root = directory.path();
        fs::create_dir_all(root.join("executors").join("unpaired")).expect("directory");
        pair_executor(root, "paired-b");
        pair_executor(root, "paired-a");
        // Not an identifier, so never listed even with state beside it.
        pair_executor(root, "..");
        assert_eq!(paired_executors(root), vec!["paired-a".to_owned(), "paired-b".to_owned()]);
        assert!(!has_executor_state(&root.join("executors").join("unpaired")));
        assert!(has_executor_state(&root.join("executors").join("paired-a")));
    }

    #[test]
    fn the_pipe_admits_recorded_grants_and_pairing_accounts_and_nothing_else() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let root = directory.path();
        fs::create_dir_all(root.join("control-clients")).expect("directory");
        fs::write(root.join("control-clients").join(SID), b"").expect("marker");
        // A file name that is not a SID is not silently handed to Win32.
        fs::write(root.join("control-clients").join("everyone"), b"").expect("marker");
        pair_executor(root, "paired-a");
        let other = "S-1-5-21-1004336348-1177238915-682003330-1002";
        fs::write(
            root.join("executors").join("paired-a").join(PAIRED_BY_FILE),
            format!("{other}\n"),
        )
        .expect("the recorded SID must be writable");
        assert_eq!(control_client_sids(root), vec![SID.to_owned(), other.to_owned()]);
    }
}
