//! The folder, tree and name rules are pure; closing is run against real
//! child processes started from a temporary "install folder".
use super::*;
use std::{os::windows::process::CommandExt, path::PathBuf, process::Command};

fn entries(rows: &[(u32, u32, &str)]) -> Vec<(u32, u32, String)> {
    rows.iter().map(|(pid, parent, name)| (*pid, *parent, (*name).to_owned())).collect()
}

#[test]
fn only_programs_inside_the_install_folder_count() {
    let folder = Path::new(r"C:\Program Files\Nessie Executor");
    assert!(inside(Path::new(r"C:\Program Files\Nessie Executor\nessie-executor-tray.exe"), folder));
    assert!(inside(Path::new(r"c:\program files\nessie executor\resources\nessie-hyperv-bridge.exe"), folder));
    assert!(!inside(Path::new(r"C:\Program Files\Nessie Executor2\nessie-executor-tray.exe"), folder));
    assert!(!inside(Path::new(r"C:\Users\person\nessie-executor-tray.exe"), folder));
    assert!(!inside(folder, folder));
}

#[test]
fn the_services_own_processes_are_left_to_the_service_stop() {
    let rows = entries(&[
        (10, 1, "nessie-executor-service.exe"),
        (11, 10, "nessie-executor-native.exe"),
        (12, 11, "nessie-executor-runtime.exe"),
        (20, 5, "nessie-executor-tray.exe"),
        (21, 20, "nessie-executor-native.exe"),
        (22, 21, "nessie-executor-runtime.exe"),
        (30, 30, "nessie-executor-runtime.exe"),
        (40, 2, "notepad.exe"),
    ]);
    assert_eq!(service_tree(&rows), BTreeSet::from([10, 11, 12]));
    let found: Vec<u32> = candidates(&rows).into_iter().map(|(pid, _)| pid).collect();
    assert_eq!(found, [20, 21, 22, 30]);
}

/// A copy of a program under one of the team images' names, started from a
/// temporary folder the way a daemon runs from the install folder.
fn start_from(folder: &Path, name: &str, program: &Path, args: &[&str]) -> (std::process::Child, PathBuf) {
    let image = folder.join(name);
    std::fs::copy(program, &image).unwrap();
    // CREATE_NO_WINDOW: a hidden console of its own, as the launcher gives a daemon.
    let child = Command::new(&image).args(args).creation_flags(0x0800_0000).spawn().unwrap();
    std::thread::sleep(Duration::from_millis(500));
    (child, image)
}

#[test]
fn what_does_not_stop_in_time_is_terminated_and_nothing_is_left_running() {
    let folder = tempfile::tempdir().unwrap();
    let ping = PathBuf::from(std::env::var("SystemRoot").unwrap()).join(r"System32\PING.EXE");
    let (mut child, _) = start_from(folder.path(), "nessie-hyperv-bridge.exe", &ping, &["-n", "60", "127.0.0.1"]);
    let found = running_from(folder.path()).unwrap();
    assert_eq!(found.len(), 1);
    let closing = close_found(found, Duration::from_secs(2), false).unwrap();
    assert_eq!(closing, Closing { apps: Vec::new(), stopped: 0, terminated: 1 });
    assert!(child.try_wait().unwrap().is_some());
    assert!(running_from(folder.path()).unwrap().is_empty());
}

/// Detaches this process from its console to send the break, so it runs on
/// its own: `cargo test -- --ignored --test-threads=1`, output to a file.
#[test]
#[ignore = "attaches to another console; run alone"]
fn a_daemon_is_asked_to_stop_with_ctrl_break_before_anything_is_terminated() {
    let folder = tempfile::tempdir().unwrap();
    // Node, as the daemon runs: it stops when it hears SIGBREAK, as the daemon now does.
    let node = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|directory| directory.join("node.exe")).find(|path| path.is_file()).expect("node on PATH");
    let script = "process.on('SIGBREAK', () => process.exit(0)); setInterval(() => {}, 1000)";
    let (mut child, _) = start_from(folder.path(), "nessie-executor-runtime.exe", &node, &["-e", script]);
    let found = running_from(folder.path()).unwrap();
    assert_eq!(found.len(), 1);
    let closing = close_found(found, Duration::from_secs(10), false).unwrap();
    assert_eq!(closing, Closing { apps: Vec::new(), stopped: 1, terminated: 0 });
    assert!(child.try_wait().unwrap().is_some());
}
