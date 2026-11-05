use super::{failure, pin, rejected, text};
use crate::{personal_state_context, protocol::NativeError, state_security};
use std::{fs::File, io::Read};

/// Retain every owner-only directory through the service clearance call. Only
/// public guard metadata and file names are inspected; no provider bytes open.
pub fn verify_deletion() -> Result<Vec<File>, NativeError> {
    let root = personal_state_context::protected_root()?;
    verify_at(&root)
}
fn verify_at(root: &std::path::Path) -> Result<Vec<File>, NativeError> {
    let nessie = root.parent().ok_or_else(rejected)?;
    let home = nessie.parent().ok_or_else(rejected)?;
    let mut held = vec![pin(home, true)?];
    for directory in [nessie, root] {
        if !directory.try_exists().map_err(|_| failure())? {
            return Ok(held);
        }
        held.push(pin(directory, true)?);
        state_security::verify_owner_only(text(directory)?)?;
    }
    let guard = root.join("guard.json");
    if !guard.try_exists().map_err(|_| failure())? {
        // A never-published preflight draft can recover only when no profile
        // namespace ever appeared. Missing guard beside profiles is corruption.
        if root.join("profiles").try_exists().map_err(|_| failure())? {
            return Err(rejected());
        }
        return Ok(held);
    }
    held.push(pin(&guard, false)?);
    state_security::verify_owner_only_file(text(&guard)?)?;
    let mut bytes = Vec::new();
    File::open(&guard)
        .map_err(|_| failure())?
        .take(1_048_577)
        .read_to_end(&mut bytes)
        .map_err(|_| failure())?;
    if bytes.len() > 1_048_576 {
        return Err(rejected());
    }
    let guard: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| rejected())?;
    if guard["version"] != 1 || guard.get("protection") != Some(&serde_json::Value::Null) {
        return Err(rejected());
    }
    let profiles = root.join("profiles");
    if !profiles.try_exists().map_err(|_| failure())? {
        return Ok(held);
    }
    held.push(pin(&profiles, true)?);
    state_security::verify_owner_only(text(&profiles)?)?;
    let mut count = 0;
    for entry in std::fs::read_dir(&profiles).map_err(|_| failure())? {
        count += 1;
        if count > 256 {
            return Err(rejected());
        }
        let entry = entry.map_err(|_| failure())?;
        held.push(pin(&entry.path(), true)?);
        state_security::verify_owner_only(text(&entry.path())?)?;
        for item in std::fs::read_dir(entry.path()).map_err(|_| failure())? {
            let item = item.map_err(|_| failure())?;
            let name = item.file_name();
            let name = name.to_str().ok_or_else(rejected)?;
            if name == "credentials.json"
                || name == "companion-key.json"
                || name.starts_with(".draft-")
            {
                return Err(rejected());
            }
        }
    }
    Ok(held)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_preflight_recovers_but_secret_files_and_missing_guard_never_clear() {
        let home = tempfile::tempdir().unwrap();
        let nessie = home.path().join(".nessie");
        let root = nessie.join("personal-inference");
        assert!(verify_at(&root).is_ok());
        for directory in [&nessie, &root] {
            std::fs::create_dir(directory).unwrap();
            state_security::secure_directory(text(directory).unwrap()).unwrap();
        }
        assert!(verify_at(&root).is_ok());
        let profiles = root.join("profiles");
        std::fs::create_dir(&profiles).unwrap();
        state_security::secure_directory(text(&profiles).unwrap()).unwrap();
        assert!(verify_at(&root).is_err());
        let guard = root.join("guard.json");
        std::fs::write(&guard, b"{\"version\":1,\"protection\":null}").unwrap();
        state_security::secure_owner_only_file(text(&guard).unwrap()).unwrap();
        let profile = profiles.join("11111111-1111-4111-8111-111111111111");
        std::fs::create_dir(&profile).unwrap();
        state_security::secure_directory(text(&profile).unwrap()).unwrap();
        assert!(verify_at(&root).is_ok());
        for name in ["credentials.json", "companion-key.json", ".draft-unknown"] {
            let path = profile.join(name);
            std::fs::write(&path, b"fixture-only").unwrap();
            assert!(verify_at(&root).is_err());
            std::fs::remove_file(&path).unwrap();
        }
        std::fs::write(&guard, b"{\"version\":1,\"protection\":{\"profiles\":[]}}").unwrap();
        assert!(verify_at(&root).is_err());
    }
}
