use crate::protocol::{
    Channel, Envelope, Manifest, SeenRelease, VerifiedManifest, UPDATER_PROTOCOL,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::DateTime;
use ed25519_dalek::{pkcs8::DecodePublicKey, Signature, VerifyingKey};
use sha2::{Digest, Sha256};
use std::{cmp::Ordering, collections::BTreeSet};

pub type UpdateResult<T> = Result<T, &'static str>;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub fn version(value: &str) -> UpdateResult<[u64; 3]> {
    let values = value.split('.').collect::<Vec<_>>();
    if values.len() != 3 {
        return Err("update.invalid_version");
    }
    let mut result = [0; 3];
    for (index, part) in values.iter().enumerate() {
        if part.is_empty()
            || part.len() > 16
            || part.len() > 1 && part.starts_with('0')
            || !part.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("update.invalid_version");
        }
        result[index] = part.parse().map_err(|_| "update.invalid_version")?;
    }
    Ok(result)
}

pub fn compare_versions(left: &str, right: &str) -> UpdateResult<Ordering> {
    Ok(version(left)?.cmp(&version(right)?))
}

fn hexadecimal(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn base64(value: &str) -> UpdateResult<Vec<u8>> {
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| "update.invalid_signature")?;
    if STANDARD.encode(&bytes) != value {
        return Err("update.invalid_signature");
    }
    Ok(bytes)
}

pub fn verify_manifest(
    envelope: &str,
    public_key: &str,
    now: i64,
    channel: Channel,
    seen: Option<&SeenRelease>,
) -> UpdateResult<VerifiedManifest> {
    if envelope.len() > 200_000 {
        return Err("update.invalid_manifest");
    }
    let frame: Envelope = serde_json::from_str(envelope).map_err(|_| "update.invalid_manifest")?;
    let payload = base64(&frame.payload)?;
    let signature = Signature::from_slice(&base64(&frame.signature)?)
        .map_err(|_| "update.invalid_signature")?;
    let key =
        VerifyingKey::from_public_key_pem(public_key).map_err(|_| "update.invalid_signature")?;
    key.verify_strict(&payload, &signature)
        .map_err(|_| "update.invalid_signature")?;
    let manifest: Manifest =
        serde_json::from_slice(&payload).map_err(|_| "update.invalid_manifest")?;
    let digest = format!("{:x}", Sha256::digest(&payload));
    if manifest.format != 1
        || manifest.sequence == 0
        || manifest.sequence > MAX_SAFE_INTEGER
        || !hexadecimal(&manifest.source_commit, 40)
        || manifest.targets.is_empty()
    {
        return Err("update.invalid_manifest");
    }
    version(&manifest.version)?;
    if manifest.channel != channel {
        return Err("update.wrong_channel");
    }
    if manifest.minimum_updater_protocol == 0
        || manifest.minimum_updater_protocol > UPDATER_PROTOCOL
    {
        return Err("update.updater_required");
    }
    let timestamp = |value: &str| -> UpdateResult<i64> {
        if !value.ends_with('Z') {
            return Err("update.invalid_manifest");
        }
        DateTime::parse_from_rfc3339(value)
            .map(|time| time.timestamp_millis())
            .map_err(|_| "update.invalid_manifest")
    };
    let published = timestamp(&manifest.published_at)?;
    let expires = timestamp(&manifest.expires_at)?;
    if published > now + 300_000 || expires <= now || expires <= published {
        return Err("update.expired_manifest");
    }
    if seen.is_some_and(|old| {
        manifest.sequence < old.sequence
            || manifest.sequence == old.sequence && digest != old.digest
    }) {
        return Err("update.replayed_manifest");
    }
    let release = format!(
        "https://github.com/UnlikeOtherAI/nessie-executor/releases/download/executor-v{}/",
        manifest.version
    );
    for assets in manifest.targets.values() {
        if assets.is_empty() || assets.len() > 3 {
            return Err("update.invalid_asset");
        }
        let mut names = BTreeSet::new();
        for asset in assets {
            let name = asset.name.as_bytes();
            if name.is_empty()
                || name.len() > 160
                || !name[0].is_ascii_alphanumeric()
                || !name
                    .iter()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(byte))
                || asset.size == 0
                || asset.size > 2_147_483_648
                || !hexadecimal(&asset.sha256, 64)
                || asset.url != format!("{release}{}", asset.name)
                || !names.insert(&asset.name)
            {
                return Err("update.invalid_asset");
            }
        }
    }
    Ok(VerifiedManifest {
        manifest,
        envelope: envelope.to_owned(),
        digest,
    })
}

pub fn release_key() -> UpdateResult<String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Key {
        format: u32,
        public_key: String,
    }
    let key: Key = serde_json::from_str(include_str!("../../src/updates/public-key.json"))
        .map_err(|_| "update.key_unavailable")?;
    if key.format != 1 {
        return Err("update.key_unavailable");
    }
    Ok(key.public_key)
}
