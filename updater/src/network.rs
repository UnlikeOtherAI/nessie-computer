//! Anonymous, bounded HTTPS downloads. Pairing and provider credentials never enter this client.
use crate::{
    catalog::UpdateResult,
    protocol::{Asset, Channel},
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
    time::Duration,
};

pub struct Network {
    agent: ureq::Agent,
    catalog_agent: ureq::Agent,
}
impl Default for Network {
    fn default() -> Self {
        let agent = |seconds| {
            ureq::Agent::config_builder()
                .https_only(true)
                .timeout_global(Some(Duration::from_secs(seconds)))
                .timeout_connect(Some(Duration::from_secs(15)))
                .timeout_per_read(Some(Duration::from_secs(30)))
                .build()
                .into()
        };
        Self {
            agent: agent(600),
            catalog_agent: agent(30),
        }
    }
}

impl Network {
    pub fn catalog(&self, channel: Channel) -> UpdateResult<String> {
        let tag = match channel {
            Channel::Stable => "update-catalog-stable",
            Channel::Preview => "update-catalog-preview",
        };
        let url = format!(
            "https://github.com/UnlikeOtherAI/nessie-executor/releases/download/{tag}/catalog.json"
        );
        let mut response = self
            .catalog_agent
            .get(&url)
            .header("User-Agent", "Nessie-Executor-Updater/1")
            .call()
            .map_err(|_| "update.check_failed")?;
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(200_001)
            .read_to_end(&mut bytes)
            .map_err(|_| "update.check_failed")?;
        if bytes.len() > 200_000 {
            return Err("update.invalid_manifest");
        }
        String::from_utf8(bytes).map_err(|_| "update.invalid_manifest")
    }

    /// The caller supplies an already signature-verified asset and a machine-owned staging directory.
    pub fn download(&self, asset: &Asset, directory: &Path) -> UpdateResult<()> {
        let destination = directory.join(&asset.name);
        if destination.exists() {
            if verify_file(&destination, asset).is_ok() {
                return Ok(());
            }
            quarantine(&destination)?;
        }
        let partial = directory.join(format!("{}.partial", asset.name));
        if let Ok(metadata) = fs::symlink_metadata(&partial) {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err("update.invalid_asset");
            }
            if metadata.len() > asset.size
                || (metadata.len() == asset.size && verify_file(&partial, asset).is_err())
            {
                quarantine(&partial)?;
            }
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let mut file = options
            .open(&partial)
            .map_err(|_| "update.download_failed")?;
        let entry = file.metadata().map_err(|_| "update.download_failed")?;
        if !entry.is_file() || entry.len() > asset.size {
            return Err("update.invalid_asset");
        }
        let offset = entry.len();
        if offset != asset.size {
            let mut request = self
                .agent
                .get(&asset.url)
                .header("User-Agent", "Nessie-Executor-Updater/1");
            let range = format!("bytes={offset}-");
            if offset > 0 {
                request = request.header("Range", &range);
            }
            let mut response = request.call().map_err(|_| "update.download_failed")?;
            let initial = match response.status().as_u16() {
                200 => {
                    file.set_len(0).map_err(|_| "update.download_failed")?;
                    0
                }
                206 if offset > 0 => {
                    let expected = format!("bytes {offset}-{}/*", asset.size - 1);
                    let exact = format!("bytes {offset}-{}/{}", asset.size - 1, asset.size);
                    let actual = response
                        .headers()
                        .get("content-range")
                        .and_then(|value| value.to_str().ok());
                    if actual != Some(exact.as_str()) && actual != Some(expected.as_str()) {
                        return Err("update.download_failed");
                    }
                    offset
                }
                _ => return Err("update.download_failed"),
            };
            use std::io::{Seek, SeekFrom};
            file.seek(SeekFrom::Start(initial))
                .map_err(|_| "update.download_failed")?;
            let mut body = response
                .body_mut()
                .as_reader()
                .take(asset.size - initial + 1);
            let mut written = initial;
            let mut buffer = [0_u8; 65536];
            loop {
                let count = body
                    .read(&mut buffer)
                    .map_err(|_| "update.download_failed")?;
                if count == 0 {
                    break;
                }
                written += count as u64;
                if written > asset.size {
                    return Err("update.invalid_asset");
                }
                file.write_all(&buffer[..count])
                    .map_err(|_| "update.download_failed")?;
            }
            file.sync_all().map_err(|_| "update.download_failed")?;
        }
        drop(file);
        if let Err(error) = verify_file(&partial, asset) {
            // Keep the failed bytes as evidence, but do not retry the same corrupt
            // complete download forever. The accepted transaction remains intact.
            if fs::metadata(&partial).is_ok_and(|entry| entry.len() >= asset.size) {
                quarantine(&partial)?;
            }
            return Err(error);
        }
        fs::rename(&partial, &destination).map_err(|_| "update.download_failed")?;
        Ok(())
    }
}

fn quarantine(path: &Path) -> UpdateResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "update.invalid_asset")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("update.invalid_asset");
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "update.download_failed")?
        .as_nanos();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("update.invalid_asset")?;
    fs::rename(
        path,
        path.with_file_name(format!("{name}.rejected.{nonce}")),
    )
    .map_err(|_| "update.download_failed")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn corrupt_downloads_are_retained_without_stranding_the_transaction() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("executor.rpm.partial");
        let asset = Asset {
            name: "executor.rpm".into(),
            url: "https://invalid.test/unused".into(),
            size: 4,
            sha256: format!("{:x}", Sha256::digest(b"good")),
        };
        fs::write(&path, b"evil").unwrap();
        assert!(verify_file(&path, &asset).is_err());
        quarantine(&path).unwrap();
        assert!(!path.exists());
        let rejected = fs::read_dir(directory.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read(rejected).unwrap(), b"evil");
        fs::write(&path, b"good").unwrap();
        verify_file(&path, &asset).unwrap();
    }
}

pub fn verify_file(path: &Path, asset: &Asset) -> UpdateResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "update.invalid_asset")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != asset.size {
        return Err("update.invalid_asset");
    }
    let mut file = fs::File::open(path).map_err(|_| "update.invalid_asset")?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|_| "update.invalid_asset")?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if format!("{:x}", hash.finalize()) != asset.sha256 {
        return Err("update.invalid_asset");
    }
    Ok(())
}
