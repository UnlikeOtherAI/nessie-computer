//! Whether Nessie Desktop is installed for this person, and where.
//!
//! Nessie Desktop's installers register the `nessie://` URL scheme: the NSIS
//! setup (installed for the current user) under `HKCU\Software\Classes`, the
//! MSI (installed for the machine) under `HKLM\Software\Classes`. Windows
//! resolves the scheme with the per-user registration first, and so does this
//! reader. The registered command names the executable, quoted, followed by
//! `"%1"`; the app is launched with no arguments, which its single-instance
//! plugin turns into focusing a window that is already open.
//!
//! The parser is a pure function so it is tested on any host; the registry
//! read lives behind `cfg(windows)`.

use std::path::{Path, PathBuf};

/// Nessie Desktop's main binary (`desktop/src-tauri/Cargo.toml`'s package
/// name, which both installers keep). A `nessie://` handler that is anything
/// else is not Nessie Desktop, and launching it with no arguments would open
/// some other program.
const DESKTOP_EXECUTABLE: &str = "nessie-desktop.exe";

/// The executable a `shell\open\command` default value launches, when it is
/// Nessie Desktop. Only the quoted form both installers write is accepted: an
/// unquoted path with a space in it cannot be split without guessing.
pub fn desktop_executable(command: &str) -> Result<String, String> {
    let quoted = command.trim().strip_prefix('"')
        .ok_or("The nessie:// handler does not name a quoted program.")?;
    let (path, rest) = quoted.split_once('"')
        .ok_or("The nessie:// handler's program path is not closed.")?;
    if !(rest.is_empty() || rest.starts_with(char::is_whitespace)) {
        return Err("The nessie:// handler's command is malformed.".into());
    }
    let drive = path.as_bytes();
    let absolute = drive.len() > 3 && drive[0].is_ascii_alphabetic() && drive[1] == b':'
        && matches!(drive[2], b'\\' | b'/');
    if !absolute || path.chars().any(char::is_control) {
        return Err("The nessie:// handler does not name an absolute program path.".into());
    }
    let file_name = path.rsplit(['\\', '/']).next().unwrap_or(path);
    if !file_name.eq_ignore_ascii_case(DESKTOP_EXECUTABLE) {
        return Err(format!("The nessie:// handler is {file_name}, not Nessie Desktop."));
    }
    Ok(path.to_owned())
}

#[cfg(windows)]
fn registered_command() -> Result<String, String> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    const KEY: &str = "Software\\Classes\\nessie\\shell\\open\\command";
    for (root, hive) in [(HKEY_CURRENT_USER, "HKCU"), (HKEY_LOCAL_MACHINE, "HKLM")] {
        match crate::registry::read_string(root, KEY, None) {
            Ok(Some(command)) => return Ok(command),
            Ok(None) => {}
            Err(status) => return Err(format!("Windows could not read {hive}\\{KEY} (error {status}).")),
        }
    }
    Err("No nessie:// handler is registered.".into())
}

#[cfg(not(windows))]
fn registered_command() -> Result<String, String> {
    Err("Nessie Desktop is detected on Windows only.".into())
}

/// Nessie Desktop's executable when it is installed, or why it is not used.
pub fn installed() -> Result<PathBuf, String> {
    let executable = PathBuf::from(desktop_executable(&registered_command()?)?);
    if !executable.is_file() {
        return Err(format!("The registered Nessie Desktop at {} is missing.", executable.display()));
    }
    Ok(executable)
}

/// Starts Nessie Desktop with no arguments. It is its own process: closing
/// this tray leaves it running.
pub fn launch(executable: &Path) -> Result<(), String> {
    std::process::Command::new(executable)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Nessie Desktop at {} could not start: {error}", executable.display()))
}

#[cfg(test)]
mod tests {
    use super::desktop_executable;

    #[test]
    fn both_installers_registrations_name_nessie_desktop() {
        assert_eq!(
            desktop_executable(r#""C:\Users\ondre\AppData\Local\Nessie\nessie-desktop.exe" "%1""#),
            Ok(r"C:\Users\ondre\AppData\Local\Nessie\nessie-desktop.exe".to_owned()),
        );
        assert_eq!(
            desktop_executable(r#"  "C:\Program Files\Nessie\Nessie-Desktop.EXE" "%1"  "#),
            Ok(r"C:\Program Files\Nessie\Nessie-Desktop.EXE".to_owned()),
        );
        assert_eq!(
            desktop_executable(r#""D:/Apps/Nessie/nessie-desktop.exe""#),
            Ok("D:/Apps/Nessie/nessie-desktop.exe".to_owned()),
        );
    }

    #[test]
    fn a_handler_that_cannot_be_read_unambiguously_is_not_used() {
        for command in [
            "",
            r#"C:\Program Files\Nessie\nessie-desktop.exe "%1""#,
            r#""C:\Program Files\Nessie\nessie-desktop.exe"#,
            r#""C:\Program Files\Nessie\nessie-desktop.exe"x "%1""#,
            r#""nessie-desktop.exe" "%1""#,
            r#""\\server\share\nessie-desktop.exe" "%1""#,
            "\"C:\\Nessie\\nessie-desktop.exe\u{7}\" \"%1\"",
        ] {
            assert!(desktop_executable(command).is_err(), "command {command:?} must be refused");
        }
    }

    #[test]
    fn another_program_claiming_the_scheme_is_not_nessie_desktop() {
        assert_eq!(
            desktop_executable(r#""C:\Tools\other.exe" "%1""#),
            Err("The nessie:// handler is other.exe, not Nessie Desktop.".to_owned()),
        );
        assert!(desktop_executable(r#""C:\Tools\nessie-desktop.exe.bat" "%1""#).is_err());
    }
}
