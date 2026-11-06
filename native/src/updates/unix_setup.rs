//! Native system services retain a protected updater independently of user daemons.
use super::{admission_unix, unix_runtime::{self, ERROR}};
use nessie_executor_updater::catalog::UpdateResult;
use std::{fs::{self, File, OpenOptions}, io::Write, os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path, process::{Command, Stdio}};

fn write(path: &Path, bytes: &[u8]) -> UpdateResult<()> {
    unix_runtime::privileged()?;
    let directory = path.parent().ok_or(ERROR)?;
    admission_unix::directory(directory)?;
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| ERROR)?.as_nanos();
    let draft = directory.join(format!(".nessie-updater-{}-{nonce}.tmp", std::process::id()));
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o644)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&draft).map_err(|_| ERROR)?;
    file.set_permissions(fs::Permissions::from_mode(0o644)).map_err(|_| ERROR)?;
    file.write_all(bytes).and_then(|()| file.sync_all()).map_err(|_| ERROR)?;
    drop(file);
    fs::rename(draft, path).map_err(|_| ERROR)?;
    File::open(directory).and_then(|file| file.sync_all()).map_err(|_| ERROR)
}
fn run(executable: &str, arguments: &[&str]) -> UpdateResult<()> {
    if !Command::new(executable).args(arguments).env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin").current_dir("/")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .status().map_err(|_| ERROR)?.success() { return Err("update.service_unavailable"); }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(super) fn configure(image: &Path) -> UpdateResult<()> {
    let _pin = unix_runtime::pin_worker(image)?;
    let unit = format!("[Unit]\nDescription=Nessie Executor updates\nAfter=network-online.target\n\
        Wants=network-online.target\n[Service]\nType=simple\nExecStart={} update-service\n\
        Restart=always\nRestartSec=5\nKillMode=process\nSendSIGKILL=no\nTimeoutStopSec=10\n\
        [Install]\nWantedBy=multi-user.target\n", image.display());
    write(Path::new("/etc/systemd/system/nessie-executor-updater.service"), unit.as_bytes())?;
    let running = Path::new("/run/systemd/system").is_dir()
        && fs::read_to_string("/proc/1/comm").is_ok_and(|value| value.trim() == "systemd");
    if running { run("/usr/bin/systemctl", &["daemon-reload"])?; }
    // An already running broker remains alive through package replacement. Its
    // next clean restart uses the new protected image; no worker is cancelled.
    let arguments: &[&str] = if running { &["enable", "--now", "nessie-executor-updater.service"] }
        else { &["enable", "nessie-executor-updater.service"] };
    run("/usr/bin/systemctl", arguments)
}

