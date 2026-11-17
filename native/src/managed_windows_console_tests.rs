use super::*;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::time::{Duration, Instant};
use windows_sys::Win32::System::Threading::DETACHED_PROCESS;

const FIXTURE: [&str; 4] = [
    "--ignored",
    "--nocapture",
    "--exact",
    "managed_windows::console_tests::launch_output_fixture",
];

#[test]
#[ignore = "spawned in a ConPTY and as a detached process by the tests below"]
fn launch_output_fixture() {
    let flags = runtime_creation_flags();
    assert_ne!(flags & CREATE_SUSPENDED, 0);
    if unsafe { GetConsoleWindow() }.is_null() {
        assert_ne!(flags & CREATE_NO_WINDOW, 0);
    }
    let program = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut child = Command::new(program)
        .args(["-NoProfile", "-Command",
            "[Console]::Out.WriteLine('runtime stdout'); [Console]::Error.WriteLine('runtime stderr'); exit 23"])
        .creation_flags(flags)
        .spawn()
        .unwrap();
    assert!(resume(&child));
    std::process::exit(child.wait().unwrap().code().unwrap());
}

#[test]
fn runtime_writes_to_the_callers_terminal() {
    let pair = native_pty_system().openpty(PtySize::default()).unwrap();
    let mut cmd = CommandBuilder::new(std::env::current_exe().unwrap());
    cmd.args(FIXTURE);
    let mut child = pair.slave.spawn_command(cmd).unwrap();
    // portable-pty requests the terminal's initial cursor position.
    let mut input = pair.master.take_writer().unwrap();
    input.write_all(b"\x1b[1;1R").unwrap();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let output = std::thread::spawn(move || {
        let mut text = String::new();
        reader.read_to_string(&mut text).unwrap();
        text
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            panic!("console fixture timed out");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    drop(input);
    drop(pair);
    let text = output.join().unwrap();
    assert_eq!(status.exit_code(), 23, "{text}");
    assert!(text.contains("runtime stdout"), "{text}");
    assert!(text.contains("runtime stderr"), "{text}");
}

#[test]
fn detached_runtime_preserves_redirected_streams() {
    let output = Command::new(std::env::current_exe().unwrap())
        .args(FIXTURE)
        .creation_flags(DETACHED_PROCESS)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(23));
    assert!(String::from_utf8_lossy(&output.stdout).contains("runtime stdout"));
    assert_eq!(
        String::from_utf8_lossy(&output.stderr).trim(),
        "runtime stderr"
    );
}
