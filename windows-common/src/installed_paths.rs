//! Known inactive Desktop/CLI entrypoints, including persistent PATH registrations.
use crate::{custody::REJECTED, registry::read_launch_string};
use std::{
    fs,
    path::{Path, PathBuf},
};
use windows_sys::Win32::System::{
    Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
    SystemInformation::GetWindowsDirectoryW,
};

fn expand(value: &str, variables: &[(&str, String)]) -> Result<String, String> {
    let mut rest = value;
    let mut output = String::new();
    while let Some(start) = rest.find('%') {
        output.push_str(&rest[..start]);
        let tail = &rest[start + 1..];
        let end = tail.find('%').ok_or(REJECTED)?;
        let (_, replacement) = variables
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(&tail[..end]))
            .ok_or(REJECTED)?;
        if replacement.contains('%') {
            return Err(REJECTED.into());
        }
        output.push_str(replacement);
        rest = &tail[end + 1..];
    }
    output.push_str(rest);
    if output.len() > 65_536 || output.chars().any(char::is_control) {
        return Err(REJECTED.into());
    }
    Ok(output)
}
fn absent(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(REJECTED.into()), // Includes dangling links and unreadable entries.
    }
}
/// The command's name and its older name: a stray launcher may answer to either.
const COMMANDS: [&str; 2] = ["nessie-computer", "nessie-executor"];

/// Every file a PATH lookup of one of [`COMMANDS`] could run, and the old Desktop app.
fn launcher_names() -> Vec<String> {
    COMMANDS
        .iter()
        .flat_map(|command| ["", ".exe", ".cmd", ".bat", ".ps1"].map(|extension| format!("{command}{extension}")))
        .chain(std::iter::once("nessie-desktop.exe".to_owned()))
        .collect()
}

fn check_path(value: &str) -> Result<(), String> {
    if value.len() > 65_536 {
        return Err(REJECTED.into());
    }
    let paths: Vec<_> = std::env::split_paths(value).collect();
    if paths.len() > 256 {
        return Err(REJECTED.into());
    }
    for path in paths {
        // Empty/relative PATH entries can launch from an unknown working directory.
        if !path.is_absolute() {
            return Err(REJECTED.into());
        }
        for name in launcher_names() {
            absent(&path.join(name))?;
        }
    }
    Ok(())
}
pub(super) fn verify(home: &Path) -> Result<(), String> {
    let mut windows = vec![0_u16; 32_768];
    let size = unsafe { GetWindowsDirectoryW(windows.as_mut_ptr(), windows.len() as u32) } as usize;
    if size == 0 || size >= windows.len() {
        return Err(REJECTED.into());
    }
    let windows = String::from_utf16(&windows[..size]).map_err(|_| REJECTED)?;
    let program_files = read_launch_string(
        HKEY_LOCAL_MACHINE,
        r"SOFTWARE\Microsoft\Windows\CurrentVersion",
        Some("ProgramFilesDir"),
        0,
    )
    .map_err(|_| REJECTED)?
    .ok_or(REJECTED)?;
    let mut variables = vec![
        ("SystemRoot", windows.clone()),
        ("windir", windows),
        ("USERPROFILE", home.to_str().ok_or(REJECTED)?.to_owned()),
        ("ProgramFiles", program_files.clone()),
    ];
    for (name, key, default) in [
        ("APPDATA", "AppData", "AppData/Roaming"),
        ("LOCALAPPDATA", "Local AppData", "AppData/Local"),
    ] {
        let raw = read_launch_string(
            HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
            Some(key),
            0,
        )
        .map_err(|_| REJECTED)?;
        let directory = match raw {
            Some(value) => PathBuf::from(expand(&value, &variables)?),
            None => home.join(default),
        };
        if !directory.is_absolute() {
            return Err(REJECTED.into());
        }
        // Desktop's old per-user install and npm's CLI wrapper remain blockers
        // even when removed from PATH or unregistered as a URL handler.
        let npm = COMMANDS
            .iter()
            .flat_map(|command| [".cmd", ".ps1", ""].map(|extension| format!("npm/{command}{extension}")));
        for file in ["Nessie/nessie-desktop.exe".to_owned(), "Programs/Nessie/nessie-desktop.exe".to_owned()]
            .into_iter()
            .chain(npm)
        {
            absent(&directory.join(file))?;
        }
        variables.push((name, directory.to_str().ok_or(REJECTED)?.to_owned()));
    }
    absent(&PathBuf::from(&program_files).join("Nessie/nessie-desktop.exe"))?;
    for (root, key) in [
        (HKEY_CURRENT_USER, r"Environment"),
        (
            HKEY_LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ),
    ] {
        if let Some(value) = read_launch_string(root, key, Some("Path"), 0).map_err(|_| REJECTED)? {
            check_path(&expand(&value, &variables)?)?;
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        check_path(path.to_str().ok_or(REJECTED)?)?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expansion_uses_actual_owner_and_os_facts_and_refuses_unknown_ambient_variables() {
        let variables = [("USERPROFILE", r"C:\Users\actual".to_owned())];
        assert_eq!(
            expand(r"%userprofile%\bin", &variables).unwrap(),
            r"C:\Users\actual\bin"
        );
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
    }

    #[test]
    fn a_stray_nessie_computer_launcher_on_path_blocks_activation() {
        for name in ["nessie-computer.cmd", "nessie-computer.ps1", "nessie-computer.exe", "nessie-computer"] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().to_str().unwrap();
            assert!(check_path(path).is_ok());
            fs::write(directory.path().join(name), b"fixture wrapper").unwrap();
            assert!(check_path(path).is_err(), "{name}");
        }
    }

    #[test]
    fn an_inactive_wrapper_or_ambiguous_search_directory_blocks_activation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().to_str().unwrap();
        assert!(check_path(path).is_ok());
        fs::write(
            directory.path().join("nessie-executor.cmd"),
            b"fixture wrapper",
        )
        .unwrap();
        assert!(check_path(path).is_err());
        assert!(check_path("relative").is_err());
        assert!(check_path("").is_err());
    }
}
