//! Detached from the public controller: only complete native job exit precedes cleanup.
use std::{
    process::{Command, Stdio},
    time::Duration,
};

pub fn attempt() {
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    let Some(root) = executable.parent() else {
        return;
    };
    let Ok(runtime) = nessie_windows_common::runtime::verify_packaged_runtime(root) else {
        return;
    };
    let mut command = Command::new(runtime.native_helper);
    command
        .arg("managed-protection-cleanup")
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for key in ["SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let Ok(mut child) = command.spawn() else {
        return;
    };
    if !matches!(
        crate::user_runtime::wait(&mut child, Duration::from_secs(15)),
        Ok(true)
    ) {
        // Killing a public-only failed probe never clears its persistent fence.
        let _ = child.kill();
        let _ = child.wait();
    }
}
