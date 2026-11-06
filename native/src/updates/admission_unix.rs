//! Public machine admission state, serialized by the existing persistent custody lock.
use crate::{managed_release::Release, protocol::NativeError};
use nessie_executor_updater::catalog::UpdateResult;
use serde::{Deserialize, Serialize};
use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt}};

const ERROR: &str = "update.state_unavailable";
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Maintenance {
    pub format: u32,
    pub draining: bool,
    pub restart_ready: bool,
    pub target: Option<String>,
}
fn valid(value: &Maintenance) -> bool {
    value.format == 1 && value.target.as_ref().is_none_or(|digest| digest.is_empty()
        || digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

pub(super) fn directory(path: &std::path::Path) -> UpdateResult<()> {
    let mut ancestor = Some(path);
    while let Some(path) = ancestor {
        let entry = fs::symlink_metadata(path).map_err(|_| ERROR)?;
        if !entry.is_dir() || entry.file_type().is_symlink() || entry.uid() != 0 || entry.mode() & 0o022 != 0 {
            return Err(ERROR);
        }
        ancestor = path.parent();
    }
    Ok(())
}

pub(super) fn read() -> UpdateResult<Maintenance> {
    let root = super::host::root()?;
    let path = root.join("maintenance.json");
    let entry = match fs::symlink_metadata(&path) {
        Ok(entry) => entry,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Maintenance { format: 1,
            ..Maintenance::default() }),
        Err(_) => return Err(ERROR),
    };
    directory(&root)?;
    if !entry.is_file() || entry.file_type().is_symlink() || entry.uid() != 0
        || entry.nlink() != 1 || entry.mode() & 0o022 != 0 || entry.len() > 4096 { return Err(ERROR); }
    let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path).map_err(|_| ERROR)?;
    let opened = file.metadata().map_err(|_| ERROR)?;
    if opened.dev() != entry.dev() || opened.ino() != entry.ino() { return Err(ERROR); }
    let mut bytes = Vec::new();
    file.take(4097).read_to_end(&mut bytes).map_err(|_| ERROR)?;
    let value: Maintenance = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
    if bytes.len() > 4096 || !valid(&value) { return Err(ERROR); }
    Ok(value)
}

/// The caller retains MachineBarrier for every mutation and package replacement.
pub(super) fn write(value: &Maintenance) -> UpdateResult<()> {
    if unsafe { libc::getuid() } != 0 || unsafe { libc::geteuid() } != 0 || !valid(value) { return Err(ERROR); }
    let root = super::host::root()?;
    directory(&root)?;
    let draft = root.join(format!(".maintenance-{}-{}.tmp", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| ERROR)?.as_nanos()));
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o644)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&draft).map_err(|_| ERROR)?;
    file.set_permissions(fs::Permissions::from_mode(0o644)).map_err(|_| ERROR)?;
    let bytes = serde_json::to_vec(value).map_err(|_| ERROR)?;
    file.write_all(&bytes).and_then(|()| file.sync_all()).map_err(|_| ERROR)?;
    drop(file);
    fs::rename(&draft, root.join("maintenance.json")).map_err(|_| ERROR)?;
    File::open(root).and_then(|directory| directory.sync_all()).map_err(|_| ERROR)
}

fn permitted(value: &Maintenance, digest: &str, arguments: &[String]) -> bool {
    if !valid(value) || value.target.as_ref().is_some_and(|target| target != digest) { return false; }
    let activity = matches!(arguments.first().map(String::as_str),
        Some("serve" | "serve-direct-local-inference" | "personal-chatgpt-credential"));
    !activity || !value.draining || value.restart_ready
}

pub(crate) fn admit(release: &Release, arguments: &[String]) -> Result<(), NativeError> {
    if super::unix_clearance::activity(arguments).is_some() && super::unix_legacy::remaining(&release.digest)
        .map_err(|_| NativeError::new("EXECUTOR_UPDATE_STATE_UNVERIFIED"))? {
        return Err(NativeError::new("EXECUTOR_UPDATE_BOOTSTRAP_REQUIRED"));
    }
    let value = read().map_err(|_| NativeError::new("EXECUTOR_UPDATE_STATE_UNVERIFIED"))?;
    if !permitted(&value, &release.digest, arguments) { return Err(NativeError::new("EXECUTOR_UPDATE_IN_PROGRESS")); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_fences_every_old_creator_and_restart_admits_only_the_selected_digest() {
        let mut state = Maintenance { format: 1, draining: true, restart_ready: false, target: None };
        assert!(!permitted(&state, &"a".repeat(64), &["serve".into()]));
        assert!(!permitted(&state, &"a".repeat(64), &["personal-chatgpt-credential".into()]));
        assert!(permitted(&state, &"a".repeat(64), &["describe".into()]));
        state.target = Some(String::new());
        assert!(!permitted(&state, &"a".repeat(64), &["describe".into()]));
        state.target = Some("b".repeat(64));
        state.restart_ready = true;
        assert!(!permitted(&state, &"a".repeat(64), &["serve".into()]));
        assert!(permitted(&state, &"b".repeat(64), &["serve".into()]));
        state.target = None;
        state.draining = false;
        assert!(permitted(&state, &"b".repeat(64), &["personal-chatgpt-credential".into()]));
        state.format = 2;
        assert!(!permitted(&state, &"b".repeat(64), &["describe".into()]));
    }
}
