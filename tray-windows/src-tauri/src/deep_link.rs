//! `nessie-computer://` links: Nessie's web sends a person to the right place
//! on this computer with one.
//!
//! ```text
//! nessie-computer://open?section=<overview|access|documents|ai|settings>[&team=<executorId>]
//! nessie-computer://connect
//! ```
//!
//! A link only navigates; it never changes anything. Windows starts this app
//! with the link as its one argument: a running copy receives it through the
//! single-instance hand-off, a new one handles it once the window has loaded.
//!
//! The scheme is registered for this person under
//! `HKCU\Software\Classes\nessie-computer` by the installer, and by the app on
//! its first run when no registration exists.

use crate::menu::{ConsoleSection, ConsoleTarget};

pub const SCHEME: &str = "nessie-computer";

#[derive(Debug, PartialEq, Eq)]
pub enum Link {
    Open(ConsoleSection, ConsoleTarget),
    Connect,
}

fn executor_id(value: &str) -> Option<String> {
    (value.len() == 36 && value.bytes().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    }))
    .then(|| value.to_ascii_lowercase())
}

/// The link's destination, or `None` for anything else. An unknown section,
/// a malformed team or an extra query parameter makes the whole link unknown
/// rather than half-followed.
pub fn parse(text: &str) -> Option<Link> {
    let url = url::Url::parse(text.trim()).ok()?;
    if url.scheme() != SCHEME || !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return None;
    }
    if !(url.path().is_empty() || url.path() == "/") || url.fragment().is_some() {
        return None;
    }
    let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    match url.host_str()? {
        "connect" if pairs.is_empty() => Some(Link::Connect),
        "open" => {
            let mut section = None;
            let mut team = None;
            for (key, value) in pairs {
                match key.as_str() {
                    "section" if section.is_none() => section = Some(ConsoleSection::parse(&value)?),
                    "team" if team.is_none() => team = Some(executor_id(&value)?),
                    _ => return None,
                }
            }
            Some(Link::Open(section?, ConsoleTarget { executor_id: team }))
        }
        _ => None,
    }
}

/// The link among a launch's arguments: Windows passes it as the only one.
pub fn from_arguments(arguments: &[String]) -> Option<Link> {
    match arguments {
        [only] if only.starts_with(&format!("{SCHEME}:")) => parse(only),
        _ => None,
    }
}

/// The values the registration writes, for this executable.
pub fn registration(executable: &str) -> [(&'static str, Option<&'static str>, String); 4] {
    [
        ("Software\\Classes\\nessie-computer", None, "URL:Nessie Computer".to_owned()),
        ("Software\\Classes\\nessie-computer", Some("URL Protocol"), String::new()),
        ("Software\\Classes\\nessie-computer\\DefaultIcon", None, format!("\"{executable}\",0")),
        ("Software\\Classes\\nessie-computer\\shell\\open\\command", None, format!("\"{executable}\" \"%1\"")),
    ]
}

/// Registers the scheme for this person when nothing is registered, or when
/// what is registered names a program that no longer exists. A working
/// registration — the installer's — is left as it is.
#[cfg(windows)]
pub fn register_if_missing() {
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
    const COMMAND: &str = "Software\\Classes\\nessie-computer\\shell\\open\\command";
    let current = crate::registry::read_string(HKEY_CURRENT_USER, COMMAND, None).ok().flatten();
    let working = current.as_deref().and_then(|command| {
        command.trim().strip_prefix('"').and_then(|rest| rest.split_once('"')).map(|(path, _)| path.to_owned())
    }).is_some_and(|path| std::path::Path::new(&path).is_file());
    if working {
        return;
    }
    let Ok(executable) = std::env::current_exe() else { return };
    for (key, name, value) in registration(&executable.display().to_string()) {
        if let Err(status) = crate::registry::write_string(HKEY_CURRENT_USER, key, name, &value) {
            eprintln!("Nessie Computer could not register its links (error {status}).");
            return;
        }
    }
}

#[cfg(not(windows))]
pub fn register_if_missing() {}

#[cfg(test)]
mod tests {
    use super::{from_arguments, parse, registration, Link};
    use crate::menu::{ConsoleSection, ConsoleTarget};

    const TEAM: &str = "1f2e3d4c-0000-4000-8000-000000000001";

    #[test]
    fn a_link_names_a_section_and_optionally_a_team() {
        assert_eq!(parse("nessie-computer://open?section=access"),
            Some(Link::Open(ConsoleSection::Access, ConsoleTarget::default())));
        assert_eq!(parse(&format!("nessie-computer://open?section=documents&team={TEAM}")),
            Some(Link::Open(ConsoleSection::Documents, ConsoleTarget::team(TEAM))));
        assert_eq!(parse(&format!("nessie-computer://open/?team={}&section=ai", TEAM.to_uppercase())),
            Some(Link::Open(ConsoleSection::Ai, ConsoleTarget::team(TEAM))));
        assert_eq!(parse("nessie-computer://connect"), Some(Link::Connect));
    }

    #[test]
    fn anything_else_is_not_followed_at_all() {
        for link in [
            "nessie-computer://open",
            "nessie-computer://open?section=billing",
            "nessie-computer://open?section=access&team=../x",
            "nessie-computer://open?section=access&section=ai",
            "nessie-computer://open?section=access&pair=1",
            "nessie-computer://connect?code=12345678",
            "nessie-computer://pause",
            "nessie-computer://open/elsewhere?section=access",
            "nessie-computer://user@open?section=access",
            "nessie://open?section=access",
            "https://open?section=access",
            "not a link",
        ] {
            assert_eq!(parse(link), None, "{link}");
        }
    }

    #[test]
    fn a_launch_carries_a_link_only_as_its_one_argument() {
        assert_eq!(from_arguments(&["nessie-computer://connect".to_owned()]), Some(Link::Connect));
        assert_eq!(from_arguments(&[]), None);
        assert_eq!(from_arguments(&["--grant-workspace".to_owned(), "nessie-computer://connect".to_owned()]), None);
    }

    #[test]
    fn the_registration_opens_this_program_with_the_link() {
        let values = registration(r"C:\Program Files\Nessie Executor\nessie-executor-tray.exe");
        assert_eq!(values[0].2, "URL:Nessie Computer");
        assert_eq!(values[1], ("Software\\Classes\\nessie-computer", Some("URL Protocol"), String::new()));
        assert_eq!(values[3].2, r#""C:\Program Files\Nessie Executor\nessie-executor-tray.exe" "%1""#);
    }
}
