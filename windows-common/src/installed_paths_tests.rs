//! Launchers on PATH: the MSI's own command line passes only in its release folder.
use super::*;

/// The layout rules alone. Production also requires a protected file; see
/// [`production_custody_also_requires_a_protected_wrapper`].
fn plain(path: &Path) -> Result<File, String> {
    File::open(path).map_err(|_| REJECTED.into())
}

/// A folder laid out as the MSI installs it: both names, the shipped bytes.
fn installed_release() -> tempfile::TempDir {
    let release = tempfile::tempdir().unwrap();
    for name in OFFICIAL_NAMES {
        fs::write(release.path().join(name), OFFICIAL_LAUNCHER).unwrap();
    }
    release
}

fn text(path: &Path) -> String {
    path.to_str().unwrap().to_owned()
}

#[test]
fn expansion_uses_actual_owner_and_os_facts_and_refuses_unknown_ambient_variables() {
    let variables = [("USERPROFILE", r"C:\Users\actual".to_owned())];
    assert_eq!(expand(r"%userprofile%\bin", &variables).unwrap(), r"C:\Users\actual\bin");
    for value in ["%HOME%\\bin", "%USERPROFILE", "%USERPROFILE%\n"] {
        assert!(expand(value, &variables).is_err());
    }
}

#[test]
fn both_command_names_are_launchers_in_every_form_windows_runs() {
    let names = launcher_names();
    for command in ["nessie-computer", "nessie-executor"] {
        for extension in ["", ".exe", ".cmd", ".bat", ".ps1"] {
            assert!(names.contains(&format!("{command}{extension}")), "{command}{extension}");
        }
    }
    assert!(names.contains(&"nessie-desktop.exe".to_owned()));
    for name in OFFICIAL_NAMES {
        assert!(names.contains(&name.to_owned()), "{name}");
    }
}

#[test]
fn the_msi_layout_on_the_machine_path_passes() {
    let release = installed_release();
    let other = tempfile::tempdir().unwrap();
    let root = text(release.path());
    // Windows Installer writes `[INSTALLFOLDER]`, which ends in a separator.
    for entry in [root.clone(), format!("{root}\\"), root.to_uppercase()] {
        let value = format!("{};{entry}", text(other.path()));
        assert!(check_path(&value, release.path(), &plain).is_ok(), "{value}");
    }
}

#[test]
fn the_shipped_names_anywhere_else_still_block() {
    let release = installed_release();
    let elsewhere = installed_release();
    assert!(check_path(&text(elsewhere.path()), release.path(), &plain).is_err());
    let nested = release.path().join("bin");
    fs::create_dir(&nested).unwrap();
    for name in OFFICIAL_NAMES {
        fs::write(nested.join(name), OFFICIAL_LAUNCHER).unwrap();
    }
    assert!(check_path(&text(&nested), release.path(), &plain).is_err());
    // The same folder spelled through `..` is not the verified release path.
    let around = format!("{}\\bin\\..", text(release.path()));
    assert!(check_path(&around, release.path(), &plain).is_err());
}

#[test]
fn a_changed_wrapper_in_the_release_folder_blocks() {
    let shipped = std::str::from_utf8(OFFICIAL_LAUNCHER).unwrap();
    let changed = [
        shipped.replace('\n', "\r\n").into_bytes(),
        format!("{shipped}rem\n").into_bytes(),
        OFFICIAL_LAUNCHER[..OFFICIAL_LAUNCHER.len() - 1].to_vec(),
        shipped.replace("managed-runtime", "managed-runtim3").into_bytes(),
        Vec::new(),
    ];
    for name in OFFICIAL_NAMES {
        for bytes in &changed {
            let release = installed_release();
            fs::write(release.path().join(name), bytes).unwrap();
            assert!(check_path(&text(release.path()), release.path(), &plain).is_err(), "{name}");
        }
    }
}

#[test]
fn any_other_launcher_in_the_release_folder_blocks() {
    for name in launcher_names().into_iter().filter(|name| !OFFICIAL_NAMES.contains(&name.as_str())) {
        let release = installed_release();
        fs::write(release.path().join(&name), OFFICIAL_LAUNCHER).unwrap();
        assert!(check_path(&text(release.path()), release.path(), &plain).is_err(), "{name}");
    }
}

#[test]
fn production_custody_also_requires_a_protected_wrapper() {
    // The shipped bytes in the right place are not enough when the person
    // could rewrite them later: a temporary folder is theirs, not Program Files'.
    let release = installed_release();
    let protected = |path: &Path| pin_protected(path, false);
    assert!(check_path(&text(release.path()), release.path(), &plain).is_ok());
    assert!(check_path(&text(release.path()), release.path(), &protected).is_err());
}

#[test]
fn a_stray_nessie_computer_launcher_on_path_blocks_activation() {
    let release = installed_release();
    for name in ["nessie-computer.cmd", "nessie-computer.ps1", "nessie-computer.exe", "nessie-computer"] {
        let directory = tempfile::tempdir().unwrap();
        let path = text(directory.path());
        assert!(check_path(&path, release.path(), &plain).is_ok());
        fs::write(directory.path().join(name), b"fixture wrapper").unwrap();
        assert!(check_path(&path, release.path(), &plain).is_err(), "{name}");
    }
}

#[test]
fn an_inactive_wrapper_or_ambiguous_search_directory_blocks_activation() {
    let release = installed_release();
    let directory = tempfile::tempdir().unwrap();
    let path = text(directory.path());
    assert!(check_path(&path, release.path(), &plain).is_ok());
    fs::write(directory.path().join("nessie-executor.cmd"), b"fixture wrapper").unwrap();
    assert!(check_path(&path, release.path(), &plain).is_err());
    assert!(check_path("relative", release.path(), &plain).is_err());
    assert!(check_path("", release.path(), &plain).is_err());
}
