//! Which Nessie this executor may pair with.
//!
//! The rule is `approveExecutorPairingOrigin` in
//! `packages/schemas/src/executor-pairing-origins.ts`, restated here in Rust
//! with a test pinning the exact same strings. Two named presets cover the
//! common services; anything else is a self-hosted HTTPS origin the person
//! types themselves. A preset id or a URL that carries a path, credentials, or
//! a query is refused, because either is a way to make one host read as
//! another in a label.

/// The hosted Nessie preset. `nessie` is the id a person selects; the URL is
/// the only value that ever reaches the pairing command.
pub const NESSIE_PRESET_ID: &str = "nessie";
pub const NESSIE_PRESET_LABEL: &str = "Nessie";
pub const NESSIE_PRESET_ORIGIN: &str = "https://api.nessie.works";

/// The hosted DeepTest preset.
pub const DEEPTEST_PRESET_ID: &str = "deeptest";
pub const DEEPTEST_PRESET_LABEL: &str = "DeepTest";
pub const DEEPTEST_PRESET_ORIGIN: &str = "https://api.deeptest.live";

/// The local API a development build may pair with, and only a development
/// build. The contract deliberately names one origin, not "any loopback".
pub const LOCAL_DEVELOPMENT_ORIGIN: &str = "http://127.0.0.1:5454";

/// A resolved pairing choice: either a named preset or a self-hosted origin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovedOrigin {
    pub origin: String,
    pub preset_id: Option<&'static str>,
}

/// The origin a build pairs with when the invitation does not name one. The
/// CLI validates the value again, so this is a convenience, not an
/// authorisation.
pub fn default_origin(is_development_build: bool) -> &'static str {
    if is_development_build {
        LOCAL_DEVELOPMENT_ORIGIN
    } else {
        NESSIE_PRESET_ORIGIN
    }
}

fn preset_id(value: &str) -> Option<&'static str> {
    match value {
        NESSIE_PRESET_ID => Some(NESSIE_PRESET_ID),
        DEEPTEST_PRESET_ID => Some(DEEPTEST_PRESET_ID),
        _ => None,
    }
}

fn preset_origin(id: &str) -> &'static str {
    match id {
        NESSIE_PRESET_ID => NESSIE_PRESET_ORIGIN,
        DEEPTEST_PRESET_ID => DEEPTEST_PRESET_ORIGIN,
        _ => unreachable!("preset_origin is only called after preset_id matched"),
    }
}

/// Approves a pairing origin the way the shared schema does. A preset id
/// resolves to its pinned origin; anything else must be an HTTPS origin with
/// no userinfo, path, query, or fragment. Plain HTTP is refused except for
/// the one local development origin, and only when the caller says this is a
/// development build.
pub fn approve(
    value: &str,
    allow_local_development: bool,
) -> Result<ApprovedOrigin, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(
            "Enter an HTTPS address for the Nessie you are pairing with, such as https://nessie.example.com."
                .to_owned(),
        );
    }
    if let Some(id) = preset_id(value) {
        return Ok(ApprovedOrigin {
            origin: preset_origin(id).to_owned(),
            preset_id: Some(id),
        });
    }

    let parsed = value
        .parse::<url::Url>()
        .map_err(|_| "Enter an HTTPS address for the Nessie you are pairing with, such as https://nessie.example.com.".to_owned())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Enter the server address without a username or password.".to_owned());
    }
    if parsed.query().is_some()
        || parsed.fragment().is_some()
        || !(parsed.path() == "/" || parsed.path().is_empty())
    {
        return Err("Enter only the server address, without a page path or anything after it.".to_owned());
    }
    let origin = parsed.origin().unicode_serialization();
    if parsed.scheme() == "https" {
        return Ok(ApprovedOrigin { origin, preset_id: None });
    }
    if allow_local_development && origin == LOCAL_DEVELOPMENT_ORIGIN {
        return Ok(ApprovedOrigin { origin, preset_id: None });
    }
    Err("The server address must start with https://.".to_owned())
}

/// Resolves the value the pairing form sends. A preset id, a known origin, or
/// the literal "custom" with a separate URL are all accepted. This keeps the
/// UI's closed vocabulary and its free-text field from drifting into two
/// sources of truth.
pub fn resolve(
    choice: &str,
    custom_url: Option<&str>,
    allow_local_development: bool,
) -> Result<ApprovedOrigin, String> {
    if choice == "custom" {
        return approve(custom_url.unwrap_or(""), allow_local_development);
    }
    approve(choice, allow_local_development)
}

/// How a surface names the origin to the person confirming it. A preset is
/// named for the service; anything else is shown as the bare host, because
/// "Custom" alone would hide the one fact that matters.
pub fn label(origin: &str) -> String {
    if origin == NESSIE_PRESET_ORIGIN {
        return NESSIE_PRESET_LABEL.to_owned();
    }
    if origin == DEEPTEST_PRESET_ORIGIN {
        return DEEPTEST_PRESET_LABEL.to_owned();
    }
    origin
        .parse::<url::Url>()
        .map(|parsed| parsed.host_str().unwrap_or(origin).to_owned())
        .unwrap_or_else(|_| origin.to_owned())
}

/// The pairing choices the status window offers in its closed dropdown. The
/// local origin is included only in development builds, matching the schema's
/// `allowLocalDevelopment` gate.
pub fn backend_choices(is_development_build: bool) -> Vec<(&'static str, &'static str)> {
    let mut choices = vec![
        (NESSIE_PRESET_ID, NESSIE_PRESET_LABEL),
        (DEEPTEST_PRESET_ID, DEEPTEST_PRESET_LABEL),
        ("custom", "Self-hosted Nessie"),
    ];
    if is_development_build {
        choices.insert(
            2,
            (LOCAL_DEVELOPMENT_ORIGIN, "Local development API (127.0.0.1:5454)"),
        );
    }
    choices
}

#[cfg(test)]
mod tests {
    use super::{
        approve, backend_choices, default_origin, label, resolve, ApprovedOrigin,
        DEEPTEST_PRESET_ID, DEEPTEST_PRESET_LABEL, DEEPTEST_PRESET_ORIGIN,
        LOCAL_DEVELOPMENT_ORIGIN, NESSIE_PRESET_ID, NESSIE_PRESET_ORIGIN,
    };

    #[test]
    fn a_preset_resolves_to_its_pinned_origin_and_names_the_service() {
        assert_eq!(
            approve(NESSIE_PRESET_ID, false),
            Ok(ApprovedOrigin {
                origin: NESSIE_PRESET_ORIGIN.to_owned(),
                preset_id: Some(NESSIE_PRESET_ID),
            }),
        );
        assert_eq!(
            approve(DEEPTEST_PRESET_ID, false),
            Ok(ApprovedOrigin {
                origin: DEEPTEST_PRESET_ORIGIN.to_owned(),
                preset_id: Some(DEEPTEST_PRESET_ID),
            }),
        );
        assert_eq!(label(DEEPTEST_PRESET_ORIGIN), DEEPTEST_PRESET_LABEL);
    }

    #[test]
    fn a_self_hosted_nessie_is_approved_and_named_by_its_host() {
        assert_eq!(
            approve("https://nessie.example.com", false),
            Ok(ApprovedOrigin {
                origin: "https://nessie.example.com".to_owned(),
                preset_id: None,
            }),
        );
        // A trailing slash is the same origin, not a second one to review.
        assert_eq!(
            approve("https://nessie.example.com/", false),
            Ok(ApprovedOrigin {
                origin: "https://nessie.example.com".to_owned(),
                preset_id: None,
            }),
        );
        assert_eq!(label("https://nessie.example.com"), "nessie.example.com");
    }

    #[test]
    fn what_a_pairing_address_may_never_be() {
        // Plain HTTP would put the pairing challenge on the network.
        assert!(approve("http://nessie.example.com", false).is_err());
        // A path is how one host is made to read as another in a label.
        assert!(approve("https://evil.example.com/api.nessie.works", false).is_err());
        assert!(approve("https://nessie.example.com?next=x", false).is_err());
        assert!(approve("https://user:pass@nessie.example.com", false).is_err());
        assert!(approve("not a url", false).is_err());
        assert!(approve("ftp://nessie.example.com", false).is_err());
    }

    #[test]
    fn the_local_api_is_reachable_only_when_a_caller_says_it_is_a_development_build() {
        assert!(approve(LOCAL_DEVELOPMENT_ORIGIN, false).is_err());
        assert_eq!(
            approve(LOCAL_DEVELOPMENT_ORIGIN, true),
            Ok(ApprovedOrigin {
                origin: LOCAL_DEVELOPMENT_ORIGIN.to_owned(),
                preset_id: None,
            }),
        );
        // The hatch is that one origin, not "any http on loopback".
        assert!(approve("http://127.0.0.1:9999", true).is_err());
    }

    #[test]
    fn the_custom_field_uses_the_same_rules() {
        assert_eq!(
            resolve("custom", Some("https://nessie.example.com"), false),
            Ok(ApprovedOrigin {
                origin: "https://nessie.example.com".to_owned(),
                preset_id: None,
            }),
        );
        assert!(resolve("custom", Some("http://nessie.example.com"), false).is_err());
        assert!(resolve("custom", None, false).is_err());
    }

    #[test]
    fn backend_choices_are_the_presets_plus_custom_and_local_only_in_development() {
        let release = backend_choices(false);
        assert!(release.iter().any(|(value, _)| *value == NESSIE_PRESET_ID));
        assert!(release.iter().any(|(value, _)| *value == DEEPTEST_PRESET_ID));
        assert!(release.iter().any(|(value, _)| *value == "custom"));
        assert!(!release.iter().any(|(value, _)| *value == LOCAL_DEVELOPMENT_ORIGIN));

        let development = backend_choices(true);
        assert!(development.iter().any(|(value, _)| *value == LOCAL_DEVELOPMENT_ORIGIN));
    }

    #[test]
    fn default_origin_follows_the_build_flavour() {
        assert_eq!(default_origin(false), NESSIE_PRESET_ORIGIN);
        assert_eq!(default_origin(true), LOCAL_DEVELOPMENT_ORIGIN);
    }
}
