//! The names this tray uses that belong to it alone.
//!
//! The service name, its virtual account, and the layout under `%ProgramData%`
//! belong to the service as much as to the tray, so they live in
//! `nessie-windows-common` and are imported where they are needed. What is left
//! here is this application's own: how it reaches that root, and where **Open
//! Nessie** goes for the server a team is paired with.

use std::path::PathBuf;

use nessie_windows_common::SERVICE_DIRECTORY_NAME;

/// The local admin that matches the local development API.
const LOCAL_CONSOLE: &str = "http://localhost:5455";

/// The Computers page of the Nessie a team is paired with — never a fixed host.
/// A hosted Nessie serves its admin beside its API, so the one rule is
/// `api.` → `app.`; any other origin is a self-hosted Nessie and is opened as
/// itself, as the macOS app does. While a pairing code is shown, the page
/// opens on **Add a computer** with that code: a one-shot intent Nessie strips
/// once it has read it.
/// One computer's own page in the console: `/admin/computers/<executorId>`.
pub fn computer_url(api_origin: &str, development: bool, executor_id: &str) -> Result<String, String> {
    if executor_id.is_empty() || executor_id.len() > 128
        || !executor_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Invalid team identity.".to_owned());
    }
    let mut url = url::Url::parse(&console_url(api_origin, development, None)?)
        .map_err(|_| "Nessie gave an address this app does not open.".to_owned())?;
    url.set_path(&format!("/admin/computers/{executor_id}"));
    Ok(url.into())
}

pub fn console_url(api_origin: &str, development: bool, code: Option<&str>) -> Result<String, String> {
    let mut url = if development && api_origin == crate::pairing_origin::LOCAL_DEVELOPMENT_ORIGIN {
        url::Url::parse(LOCAL_CONSOLE).map_err(|_| "This app could not prepare the Nessie address.".to_owned())?
    } else {
        let mut url = url::Url::parse(api_origin).map_err(|_| "Nessie gave an address this app does not open.")?;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
            return Err("Nessie gave an address this app does not open.".to_owned());
        }
        let host = url.host_str().ok_or("Nessie gave an address this app does not open.")?.to_owned();
        if let Some(rest) = host.strip_prefix("api.") {
            url.set_host(Some(&format!("app.{rest}"))).map_err(|_| "Nessie gave an address this app does not open.")?;
        }
        url
    };
    url.set_path("/admin/computers");
    url.set_query(None);
    url.set_fragment(None);
    if let Some(code) = code {
        if code.len() != 8 || !code.bytes().all(|digit| digit.is_ascii_digit()) {
            return Err("Invalid pairing code.".to_owned());
        }
        url.query_pairs_mut().append_pair("create", "1").append_pair("code", code);
    }
    Ok(url.into())
}

/// The service's root under `%ProgramData%`. A host that does not report that
/// directory is not one the service lays its state down on, and guessing a
/// path there would record a grant somewhere the service never reads.
pub fn service_root() -> Result<PathBuf, String> {
    let program_data = std::env::var_os("ProgramData")
        .ok_or_else(|| "Windows reported no ProgramData directory.".to_owned())?;
    Ok(PathBuf::from(program_data).join(SERVICE_DIRECTORY_NAME))
}

#[cfg(test)]
mod tests {
    use super::console_url;

    #[test]
    fn open_nessie_goes_to_the_paired_servers_computers_page() {
        assert_eq!(console_url("https://api.nessie.works", false, None).unwrap(),
            "https://app.nessie.works/admin/computers");
        assert_eq!(console_url("https://api.deeptest.live", false, None).unwrap(),
            "https://app.deeptest.live/admin/computers");
        // A self-hosted Nessie is opened as itself.
        assert_eq!(console_url("https://nessie.acme.example", false, None).unwrap(),
            "https://nessie.acme.example/admin/computers");
        assert_eq!(console_url("http://127.0.0.1:5454", true, None).unwrap(), "http://localhost:5455/admin/computers");
        assert!(console_url("http://127.0.0.1:5454", false, None).is_err());
        assert!(console_url("http://nessie.acme.example", false, None).is_err());
    }

    #[test]
    fn while_pairing_the_page_opens_on_add_a_computer_with_the_code() {
        assert_eq!(super::computer_url("https://api.nessie.works", false, "0b6a3f14-98d2-4c57").unwrap(),
            "https://app.nessie.works/admin/computers/0b6a3f14-98d2-4c57");
        for id in ["", "../x", "a/b", "a?b"] {
            assert!(super::computer_url("https://api.nessie.works", false, id).is_err(), "{id}");
        }
        assert_eq!(console_url("https://api.nessie.works", false, Some("12345678")).unwrap(),
            "https://app.nessie.works/admin/computers?create=1&code=12345678");
        for code in ["1234567", "123456789", "1234567a", "12345678&x=1"] {
            assert!(console_url("https://api.nessie.works", false, Some(code)).is_err(), "{code}");
        }
    }
}
