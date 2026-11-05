use crate::protocol::NativeError;

#[cfg(not(windows))]
pub fn run(_argv: &[String]) -> Result<i32, NativeError> {
    Err(NativeError::new("EXECUTOR_NATIVE_UNSUPPORTED_PLATFORM"))
}

/// The parent session host owns containment. This child only provides ConPTY.
/// argv is already validated by the command parser; input and output are bytes.
#[cfg(windows)]
pub fn run(argv: &[String]) -> Result<i32, NativeError> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::{self, Read, Write};
    let failed = |_| NativeError::new("EXECUTOR_TERMINAL_FAILED");
    #[cfg(not(debug_assertions))]
    let lease = crate::managed_windows::acquire_host()?;
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 36,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(failed)?;
    let mut command = CommandBuilder::new(&argv[0]);
    command.args(&argv[1..]);
    command.cwd(std::env::current_dir().map_err(|_| NativeError::new("EXECUTOR_TERMINAL_FAILED"))?);
    let mut child = pair.slave.spawn_command(command).map_err(failed)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(failed)?;
    let mut writer = pair.master.take_writer().map_err(failed)?;
    let mut killer = child.clone_killer();
    std::thread::spawn(move || {
        let _ = io::copy(&mut io::stdin().lock(), &mut writer);
        let _ = killer.kill();
    });
    let output = std::thread::spawn(move || {
        let mut bytes = [0_u8; 8192];
        let mut stdout = io::stdout().lock();
        while let Ok(count) = reader.read(&mut bytes) {
            if count == 0 || stdout.write_all(&bytes[..count]).is_err() {
                break;
            }
            if stdout.flush().is_err() {
                break;
            }
        }
    });
    let status = child
        .wait()
        .map_err(|_| NativeError::new("EXECUTOR_TERMINAL_FAILED"))?;
    drop(pair.master);
    let _ = output.join();
    #[cfg(not(debug_assertions))]
    crate::managed_windows::release_host(&lease)?;
    Ok(status.exit_code() as i32)
}
