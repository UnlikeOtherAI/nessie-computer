use crate::protocol::NativeError;

pub fn run_authorized(argv: &[String]) -> Result<i32, NativeError> {
    run_mode(argv, true)
}
pub fn run(argv: &[String]) -> Result<i32, NativeError> {
    run_mode(argv, false)
}

#[cfg(not(windows))]
fn run_mode(_argv: &[String], _authorized: bool) -> Result<i32, NativeError> {
    Err(NativeError::new("EXECUTOR_NATIVE_UNSUPPORTED_PLATFORM"))
}

/// The parent session host owns containment. This child only provides ConPTY.
/// argv is already validated by the command parser; input and output are bytes.
#[cfg(windows)]
fn run_mode(argv: &[String], authorized: bool) -> Result<i32, NativeError> {
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
    let mut channel = if authorized {
        Some(crate::session_effect::inherited()?)
    } else {
        None
    };
    let launch = if let Some(ref mut receiver) = channel {
        Some(receiver.launch(argv)?)
    } else {
        None
    };
    if let (Some(receiver), Some(frame)) = (&mut channel, &launch) {
        receiver.consume(frame)?;
    }
    let mut child = pair.slave.spawn_command(command).map_err(failed)?;
    if let (Some(receiver), Some(frame)) = (&mut channel, &launch) {
        if receiver.outcome(frame, "accepted").is_err() {
            let _ = child.kill();
            return Err(NativeError::new(crate::session_effect::REFUSED));
        }
    }
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(failed)?;
    let mut writer = pair.master.take_writer().map_err(failed)?;
    let mut killer = child.clone_killer();
    std::thread::spawn(move || {
        if let Some(receiver) = channel {
            let _ = receiver.relay(writer, true);
        } else {
            let _ = io::copy(&mut io::stdin().lock(), &mut writer);
        }
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
