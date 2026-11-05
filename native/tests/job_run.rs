//! `job-run` driven as the session host drives it: the built helper binary,
//! real child processes, and the process table afterwards. Each assertion is
//! about what is left running, which only a real process tree can show.
#![cfg(windows)]

use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};

use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};

const HELPER: &str = env!("CARGO_BIN_EXE_nessie-executor-native");

fn system32(program: &str) -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_owned());
    format!(r"{root}\System32\{program}")
}

/// A PowerShell line that starts `ping` as its own child — outside the
/// process tree `taskkill /T` would still find once PowerShell exits — and
/// prints that child's pid.
const START_GRANDCHILD: &str = "$i = New-Object System.Diagnostics.ProcessStartInfo 'ping.exe', '-n 120 127.0.0.1'; \
    $i.UseShellExecute = $false; $i.CreateNoWindow = $true; $i.RedirectStandardOutput = $true; \
    [Console]::Out.WriteLine([System.Diagnostics.Process]::Start($i).Id); [Console]::Out.Flush()";

/// True once `pid` has exited, waiting at most five seconds for it to.
fn exits_within_five_seconds(pid: u32) -> bool {
    let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if process.is_null() {
        return true;
    }
    let waited = unsafe { WaitForSingleObject(process, 5_000) };
    unsafe { CloseHandle(process) };
    waited == WAIT_OBJECT_0
}

fn first_line_pid(reader: &mut impl BufRead) -> u32 {
    let mut line = String::new();
    reader.read_line(&mut line).expect("the program prints a pid");
    line.trim().parse().expect("the first line is a pid")
}

#[test]
fn the_exit_code_is_the_programs_own() {
    let status = Command::new(HELPER)
        .args(["job-run", "--", &system32("cmd.exe"), "/c", "exit 7"])
        .status()
        .expect("the helper runs");
    assert_eq!(status.code(), Some(7));
}

#[test]
fn stdin_and_stdout_pass_straight_through() {
    let mut child = Command::new(HELPER)
        .args(["job-run", "--", &system32("sort.exe")])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("the helper runs");
    child.stdin.take().expect("stdin is piped").write_all(b"b\r\na\r\n").expect("stdin accepts input");
    let output = child.wait_with_output().expect("the helper exits");
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&output.stdout), "a\r\nb\r\n");
}

#[test]
fn a_program_that_cannot_start_is_refused_on_stderr_with_the_wrapper_code() {
    let output = Command::new(HELPER)
        .args(["job-run", "--", r"C:\nessie-no-such-directory\agent.exe", "--version"])
        .output()
        .expect("the helper runs");
    assert_eq!(output.status.code(), Some(125));
    assert!(output.stdout.is_empty(), "stdout belongs to the program, which never ran");
    let refusal = String::from_utf8_lossy(&output.stderr);
    assert!(refusal.contains(r#""code":"EXECUTOR_JOB_SPAWN_FAILED""#), "{refusal}");
    assert!(refusal.contains(r#""status":"rejected""#), "{refusal}");
}

#[test]
fn what_the_program_leaves_behind_dies_when_it_exits() {
    let mut child = Command::new(HELPER)
        .args(["job-run", "--", &system32(r"WindowsPowerShell\v1.0\powershell.exe"), "-NoProfile", "-Command", START_GRANDCHILD])
        .stdout(Stdio::piped())
        .spawn()
        .expect("the helper runs");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout is piped"));
    let grandchild = first_line_pid(&mut stdout);
    let status = child.wait().expect("the helper exits");
    assert_eq!(status.code(), Some(0));
    assert!(exits_within_five_seconds(grandchild), "the orphaned ping {grandchild} outlived the job");
}

#[test]
fn the_whole_job_dies_with_the_process_that_started_the_helper() {
    // `cmd.exe` stands in for the session host: the helper's parent.
    let program = format!(
        r#""{HELPER}" job-run -- "{}" -NoProfile -Command "[Console]::Out.WriteLine($PID); [Console]::Out.Flush(); Start-Sleep 120""#,
        system32(r"WindowsPowerShell\v1.0\powershell.exe"),
    );
    // cmd.exe parses its own command line, so it is handed one verbatim.
    let mut host = Command::new(system32("cmd.exe"))
        .raw_arg(format!("/d /s /c \"{program}\""))
        .stdout(Stdio::piped())
        .spawn()
        .expect("the stand-in host runs");
    let mut stdout = BufReader::new(host.stdout.take().expect("stdout is piped"));
    let agent = first_line_pid(&mut stdout);
    host.kill().expect("the stand-in host can be killed");
    let _ = host.wait();
    assert!(exits_within_five_seconds(agent), "the agent {agent} outlived its host");
}
