//! A fixed CLI doorway; unrelated package-manager launchers retain ownership.
use super::{admission_unix, unix_runtime::{self, ERROR}};
use nessie_executor_updater::catalog::UpdateResult;
use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, os::unix::fs::{MetadataExt, OpenOptionsExt,
    PermissionsExt}, path::Path};

const PREFIX: &str = "#!/bin/sh\nset -eu\nunset NODE_OPTIONS NODE_PATH LD_PRELOAD DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH\n";
const ROOT: &str = "/Library/Application Support/Nessie Executor";
fn launcher(relative: &str) -> String {
    format!("{PREFIX}exec '{ROOT}/{relative}/nessie-executor-native' managed-runtime -- \"$@\"\n")
}

pub(super) fn install() -> UpdateResult<()> {
    unix_runtime::privileged()?;
    let bin = Path::new("/usr/local/bin");
    // A Homebrew-owned prefix cannot become a Root-controlled CLI directory.
    // The app and its protected factory still work without taking that prefix.
    for parent in [Path::new("/usr/local"), bin] {
        if parent.exists() && admission_unix::directory(parent).is_err() { return Ok(()); }
        unix_runtime::directory(parent)?;
    }
    let target = bin.join("nessie-executor");
    let expected = launcher("current");
    match fs::symlink_metadata(&target) {
        Ok(entry) => {
            if !entry.is_file() || entry.file_type().is_symlink() || entry.uid() != 0 || entry.nlink() != 1
                || entry.mode() & 0o022 != 0 || entry.len() > 4096 { return Ok(()); }
            let mut bytes = String::new();
            File::open(&target).map_err(|_| ERROR)?.take(4097).read_to_string(&mut bytes).map_err(|_| ERROR)?;
            if bytes == expected { return Ok(()); }
            let digest = bytes.strip_prefix(&format!("{PREFIX}exec '{ROOT}/releases/"))
                .and_then(|tail| tail.split('/').next()).unwrap_or("");
            if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                || bytes != launcher(&format!("releases/{digest}")) { return Ok(()); }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(_) => return Err(ERROR),
    }
    let mut random = [0_u8; 16];
    unsafe { libc::arc4random_buf(random.as_mut_ptr().cast(), random.len()); }
    let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let draft = bin.join(format!(".nessie-executor-{nonce}"));
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o755)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&draft).map_err(|_| ERROR)?;
    file.set_permissions(fs::Permissions::from_mode(0o755)).map_err(|_| ERROR)?;
    file.write_all(expected.as_bytes()).and_then(|()| file.sync_all()).map_err(|_| ERROR)?;
    fs::rename(draft, target).map_err(|_| ERROR)?;
    File::open(bin).and_then(|file| file.sync_all()).map_err(|_| ERROR)
}
