//! Inspect accounts that have Nessie state without treating service data as a user home.
use std::{fs, os::unix::fs::MetadataExt, path::Path};

/// Absence is established before enforcing private-state permissions. System
/// accounts may own group-writable runtime directories without any Nessie data.
/// Existing, symlinked or unreadable Nessie state never takes that exemption.
pub(crate) fn needs_custody_inspection(home: &Path, uid: u32) -> Result<bool, ()> {
    let entry = match fs::symlink_metadata(home) {
        Ok(entry) => entry,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(()),
    };
    if entry.uid() != uid { return Ok(false); }
    if !entry.is_dir() || entry.file_type().is_symlink() { return Err(()); }
    let state = match fs::symlink_metadata(home.join(".nessie")) {
        Ok(state) => state,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(()),
    };
    if entry.mode() & 0o022 != 0 || !state.is_dir() || state.file_type().is_symlink()
        || state.uid() != uid || state.mode() & 0o022 != 0 { return Err(()); }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn group_writable_service_directory_without_nessie_state_is_unrelated() {
        let home = tempfile::tempdir().unwrap();
        fs::set_permissions(home.path(), fs::Permissions::from_mode(0o775)).unwrap();
        assert_eq!(needs_custody_inspection(home.path(), unsafe { libc::getuid() }), Ok(false));
    }

    #[test]
    fn existing_state_keeps_the_home_and_state_ownership_permission_barriers() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join(".nessie");
        fs::create_dir(&state).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        let uid = unsafe { libc::getuid() };
        fs::set_permissions(home.path(), fs::Permissions::from_mode(0o775)).unwrap();
        assert!(needs_custody_inspection(home.path(), uid).is_err());
        fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(needs_custody_inspection(home.path(), uid), Ok(true));
        fs::set_permissions(&state, fs::Permissions::from_mode(0o770)).unwrap();
        assert!(needs_custody_inspection(home.path(), uid).is_err());
        assert_eq!(needs_custody_inspection(home.path(), uid.wrapping_add(1)), Ok(false));
    }

    #[test]
    fn a_dangling_state_symlink_is_present_and_refused() {
        let home = tempfile::tempdir().unwrap();
        symlink(home.path().join("missing"), home.path().join(".nessie")).unwrap();
        assert!(needs_custody_inspection(home.path(), unsafe { libc::getuid() }).is_err());
    }

    #[test]
    fn a_symlinked_home_cannot_hide_state() {
        let directory = tempfile::tempdir().unwrap();
        let link = directory.path().join("home");
        symlink(directory.path(), &link).unwrap();
        assert!(needs_custody_inspection(&link, unsafe { libc::getuid() }).is_err());
    }
}
