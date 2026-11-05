//! Installed entrypoints are checked separately from loaded-process provenance.
use crate::{managed_release::Release, managed_runtime_context, protocol::NativeError};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

fn refused() -> NativeError {
    NativeError::new("EXECUTOR_INSTALLED_CUSTODY_UNVERIFIED")
}
fn absent(path: &Path) -> Result<bool, NativeError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Err(refused()),
    }
}

fn launcher(release: &Release) -> String {
    format!(
        "#!/bin/sh\n\
# Runs one root-owned immutable release. Upgrade selects a new directory;\n\
# an existing process and its children keep their original release.\n\
set -eu\n\
unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH\n\
NESSIE_EXECUTOR_PACKAGED_CLI=1\n\
export NESSIE_EXECUTOR_PACKAGED_CLI\n\
exec {}/nessie-executor-native managed-runtime -- \"$@\"\n",
        release.directory.display()
    )
}

/// The current supported personal-auth entrypoint is the native Linux package.
/// Desktop/AppImage embedded launchers need their own same-barrier consumer;
/// their presence is refused rather than inferred compatible from a disk hash.
pub fn verify(release: &Release) -> Result<(), NativeError> {
    let path = Path::new("/usr/bin/nessie-executor");
    let metadata = fs::symlink_metadata(path).map_err(|_| refused())?;
    if !metadata.is_file()
        || metadata.uid() != 0
        || metadata.nlink() != 1
        || metadata.mode() & 0o022 != 0
        || metadata.len() > 8192
        || fs::read_to_string(path).map_err(|_| refused())? != launcher(release)
    {
        return Err(refused());
    }
    for path in [
        "/usr/bin/nessie",
        "/usr/bin/Nessie",
        "/usr/bin/nessie-desktop",
        "/usr/lib/nessie",
        "/usr/lib/Nessie",
        "/usr/share/nessie",
        "/usr/share/Nessie",
        "/opt/nessie",
        "/opt/Nessie",
        "/usr/local/bin/nessie-executor",
        "/usr/lib/nessie-executor/nessie-executor-runtime",
        "/usr/lib/nessie-executor/nessie-executor.cjs",
        "/usr/share/applications/nessie.desktop",
        "/usr/share/applications/com.unlikeotherai.nessie.desktop.desktop",
    ] {
        if !absent(Path::new(path))? {
            return Err(refused());
        }
    }
    let home = managed_runtime_context::home()?;
    for name in ["nessie.desktop", "com.unlikeotherai.nessie.desktop.desktop"] {
        if !absent(&home.join(".local/share/applications").join(name))? {
            return Err(refused());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installed_launcher_binds_exact_release_and_never_node_loader_arguments() {
        let directory = tempfile::tempdir().unwrap();
        let release = Release {
            directory: directory.path().to_path_buf(),
            digest: "a".repeat(64),
            node: fs::File::open("/bin/sh").unwrap(),
            node_digest: "fixture-only".to_owned(),
            handles: Vec::new(),
        };
        let script = launcher(&release);
        assert!(script.ends_with("/nessie-executor-native managed-runtime -- \"$@\"\n"));
        assert!(!script.contains("exec node"));
        let symlink = directory.path().join("unknown-entrypoint");
        std::os::unix::fs::symlink("does-not-exist", &symlink).unwrap();
        assert!(
            !absent(&symlink).unwrap(),
            "a dangling installed entry is not positive absence"
        );
    }
}
