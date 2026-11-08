//! The values a control request carries, checked before anything acts on them:
//! the server a pairing names, a pairing challenge, a workspace path and the
//! workspace operations a policy may allow.

/// The workspace operations the local policy may allow, in canonical order.
pub const WORKSPACE_OPERATION_KEYS: [&str; 5] = [
    "file.list",
    "file.read",
    "file.write",
    "workspace.review",
    "sandbox.stop",
];

/// The longest pairing challenge the API mints, matched to the desktop
/// companion's own bound so neither accepts what the other refuses.
const MAX_CHALLENGE_BYTES: usize = 8_192;

/// Windows' extended path limit. A workspace root longer than this cannot name
/// a real directory.
const MAX_WORKSPACE_BYTES: usize = 32_767;

pub(crate) const MAX_IDENTIFIER_BYTES: usize = 128;

/// The longest request line the pipe will read. A pairing challenge plus a
/// workspace path plus JSON framing fits with room to spare; anything larger is
/// a caller that has lost the protocol, not a command.
pub const MAX_REQUEST_BYTES: usize = 65_536;

pub(crate) const NESSIE_API_BASE_URL: &str = "https://api.nessie.works";
const DEEPTEST_API_BASE_URL: &str = "https://api.deeptest.live";
pub(crate) const LOOPBACK_API_BASE_URLS: [&str; 2] = ["http://127.0.0.1:5454", "http://localhost:5454"];

pub(crate) fn approved_api_base_url(value: &str) -> Result<String, String> {
    if value == NESSIE_API_BASE_URL || value == DEEPTEST_API_BASE_URL {
        return Ok(value.to_owned());
    }
    // A local owner may deliberately pair to this machine's development API.
    // This is a closed loopback set, not a general HTTP exception: a pasted
    // invitation can never route the machine key to a LAN or internet host.
    if LOOPBACK_API_BASE_URLS.contains(&value) {
        return Ok(value.to_owned());
    }
    // Nessie is open source and self-hosted. Anything else must be an HTTPS
    // origin with no credentials, path, query or fragment — the same rule the
    // shared schema enforces so one host cannot be dressed up as another.
    let parsed = value.parse::<url::Url>().map_err(|_| {
        "Choose Nessie cloud, DeepTest, an approved local API, or an HTTPS origin.".to_owned()
    })?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Enter the server address without a username or password.".to_owned());
    }
    if parsed.query().is_some()
        || parsed.fragment().is_some()
        || !(parsed.path() == "/" || parsed.path().is_empty())
    {
        return Err(
            "Enter only the server address, without a page path or anything after it.".to_owned(),
        );
    }
    if parsed.scheme() == "https" {
        Ok(parsed.origin().unicode_serialization())
    } else {
        Err("The server address must start with https://.".to_owned())
    }
}

pub(crate) fn challenge(value: String) -> Result<String, String> {
    if value.is_empty() || value.len() > MAX_CHALLENGE_BYTES || value.contains('\0') {
        return Err("The pairing challenge is malformed.".to_owned());
    }
    Ok(value)
}

pub(crate) fn workspace_root(value: String) -> Result<String, String> {
    if value.is_empty()
        || value.len() > MAX_WORKSPACE_BYTES
        || value.contains('\0')
        || !std::path::Path::new(&value).is_absolute()
    {
        return Err("Choose one existing absolute workspace directory.".to_owned());
    }
    Ok(value)
}

/// Canonicalizes the requested policy the way the desktop companion does: a
/// known set, each key at most once, always in the one declared order.
pub(crate) fn workspace_operation_keys(requested: Vec<String>) -> Result<Vec<String>, String> {
    if requested.is_empty()
        || requested.len() > WORKSPACE_OPERATION_KEYS.len()
        || requested
            .iter()
            .any(|key| !WORKSPACE_OPERATION_KEYS.contains(&key.as_str()))
    {
        return Err("Choose one or more supported workspace operations.".to_owned());
    }
    let mut unique = requested.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != requested.len() {
        return Err("Choose each workspace operation only once.".to_owned());
    }
    Ok(WORKSPACE_OPERATION_KEYS
        .iter()
        .filter(|key| requested.iter().any(|value| value == *key))
        .map(|key| (*key).to_owned())
        .collect())
}

