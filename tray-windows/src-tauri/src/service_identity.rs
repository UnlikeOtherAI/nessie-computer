//! The names this tray uses that belong to it alone.
//!
//! The service name, its virtual account, and the layout under `%ProgramData%`
//! belong to the service as much as to the tray, so they live in
//! `nessie-windows-common` and are imported where they are needed. What is left
//! here is this application's own: how it reaches that root, and where its menu
//! items go.

use std::path::PathBuf;

use nessie_windows_common::SERVICE_DIRECTORY_NAME;

/// Where **Open Nessie** goes: the page that mints an executor invitation and
/// confirms its fingerprint.
pub const NESSIE_EXECUTORS_URL: &str = "https://app.nessie.works/admin/computers";

/// Where **Open Nessie** goes for a DeepTest executor.
pub const DEEPTEST_EXECUTORS_URL: &str = "https://app.deeptest.live/admin/computers";

/// The local admin origin that matches the local API origin. A development
/// build opens the local admin; a release opens one of the hosted origins.
pub const LOCAL_EXECUTORS_URL: &str = "http://localhost:5455/admin/computers";

/// The pairing picker offers this closed set. Mapping API to its matching
/// admin page here prevents a local invitation flow from sending someone back
/// to cloud and creating an invitation for the wrong trust domain.
pub fn executors_url_for_api(api_base_url: &str) -> Result<&'static str, String> {
    match api_base_url {
        "https://api.nessie.works" => Ok(NESSIE_EXECUTORS_URL),
        "https://api.deeptest.live" => Ok(DEEPTEST_EXECUTORS_URL),
        "http://127.0.0.1:5454" | "http://localhost:5454" => Ok(LOCAL_EXECUTORS_URL),
        _ => Err("Choose a supported Nessie backend first.".to_owned()),
    }
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
    use super::{
        executors_url_for_api, DEEPTEST_EXECUTORS_URL, LOCAL_EXECUTORS_URL, NESSIE_EXECUTORS_URL,
    };

    /// Opened in the person's browser, so it is the admin origin rather than
    /// the API one, and it is fixed rather than assembled from anything a
    /// caller supplies.
    #[test]
    fn open_nessie_goes_to_the_executors_page_on_the_admin_origin() {
        assert_eq!(NESSIE_EXECUTORS_URL, "https://app.nessie.works/admin/computers");
        assert_eq!(
            executors_url_for_api("https://api.deeptest.live").unwrap(),
            DEEPTEST_EXECUTORS_URL,
        );
        assert_eq!(
            executors_url_for_api("http://127.0.0.1:5454").unwrap(),
            LOCAL_EXECUTORS_URL,
        );
        assert!(executors_url_for_api("https://nessie.example.com").is_err());
    }
}
