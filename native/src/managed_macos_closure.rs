//! Whether a macOS creation journal's creation has ended, and dropping this
//! boot's that have: the rule the supervisor, each new creation and update
//! clearance share.
use crate::{macos_processes, managed_runtime::Record, protocol::NativeError};
use std::{collections::HashSet, fs::{self, File, OpenOptions}, os::unix::fs::OpenOptionsExt, path::Path};

fn refused() -> NativeError { NativeError::new("EXECUTOR_MANAGED_LAUNCH_REJECTED") }

/// Whether this runtime admitted host execution that is still unresolved: a
/// `host_execution` registration its own child made in this boot whose
/// admitted process is not proved ended (`execution_ended`). Another
/// runtime's registrations are not this journal's to keep, and a restart ended
/// any an earlier boot made. Counting every registration made each one-shot
/// command (`describe`, every five seconds) keep its journal and exit refused
/// once any team had run a local app: 371 journals in half an hour on
/// dictator, a team that never started and a runtime swap that never cleared.
pub(crate) fn unresolved_host(root: &Path, record: &Record, live_groups: &HashSet<i32>) -> Result<bool, NativeError> {
    let file = match OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(root.join("guard.json")) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(refused()),
    };
    let state: serde_json::Value = serde_json::from_reader(file).map_err(|_| refused())?;
    Ok(state["registrations"].as_array().ok_or_else(refused)?.iter()
        .any(|item| own_host(item, record) && !execution_ended(item, live_groups)))
}

/// Whether the host process a registration admitted is proved to have ended:
/// it was bound, and it, every descendant recorded with it and a group it
/// leads are all gone. A runtime releases its registration once it stops what
/// it started; one that crashed never does, so without this proof its journal
/// held every update until a restart. A registration with no bound process
/// may have started one nobody recorded and stays unresolved. Its `startedAt`
/// is `ps`'s whole epoch second.
fn execution_ended(item: &serde_json::Value, live_groups: &HashSet<i32>) -> bool {
    let execution = &item["execution"];
    let (identity, Some(descendants)) = (&execution["identity"], execution["descendants"].as_array()) else {
        return false;
    };
    let pid = |process: &serde_json::Value| process["pid"].as_i64()
        .and_then(|pid| i32::try_from(pid).ok()).filter(|pid| *pid > 0);
    let ended = |process: &serde_json::Value| {
        let Some(pid) = pid(process) else { return false };
        match macos_processes::information(pid) {
            Ok(None) => true,
            Ok(Some(live)) => live.zombie || process["startedAt"].as_str().is_some_and(|second|
                live.started_at.parse::<u64>().is_ok_and(|micros| (micros / 1_000_000).to_string() != second)),
            Err(_) => false,
        }
    };
    let group = identity["containment"] == "posix_group";
    ended(identity) && descendants.iter().all(ended)
        && !(group && pid(identity).map_or(true, |leader| live_groups.contains(&leader)))
}

/// Drops this boot's journals whose creation ended (`ended_creation`): a
/// one-shot command that would have dropped its own, and a runtime whose
/// supervisor could not. Builds before this kept them whenever any team held a
/// host registration, or whenever the supervisor had refused a snapshot, and
/// clearance waits for none to be left, so without this a Mac recovered only by
/// restarting. Anything still running keeps its journal.
pub(crate) fn reconcile(directory: &Path, boot: &str) -> Result<(), NativeError> {
    let root = directory.parent().ok_or_else(refused)?;
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(refused()),
    };
    let groups = macos_processes::live_groups()?;
    for entry in entries {
        let path = entry.map_err(|_| refused())?.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") { continue; }
        let Ok(file) = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(&path) else { continue };
        let Ok(record) = serde_json::from_reader::<_, Record>(file) else { continue };
        if record.boot_id != boot || !ended_creation(&record, root, &groups)? { continue; }
        fs::remove_file(&path).map_err(|_| refused())?;
        let socket = path.with_extension("sock");
        if fs::symlink_metadata(&socket).is_ok() { fs::remove_file(&socket).map_err(|_| refused())?; }
    }
    File::open(directory).map_err(|_| refused())?.sync_all().map_err(|_| refused())
}

/// A journal whose creation ended: supervisor and child ended, nothing of any
/// account left in the child's process group (`live_groups`, taken once by the
/// caller), and no unresolved host admission of its own under `root`. A
/// process this caller cannot read counts as still running. This holds for a
/// daemon as for a one-shot command: a daemon's supervisor drops its own
/// journal after following the whole tree, so one left behind is a supervisor
/// that ended first, as every earlier build's did on a refused snapshot. Update
/// clearance does not wait for these, and still waits for every product
/// process, including any such a runtime left outside its group. Retired host
/// authority is archived separately; its removal does not claim escaped programs
/// ended.
pub(crate) fn ended_creation(
    record: &Record, root: &Path, live_groups: &HashSet<i32>,
) -> Result<bool, NativeError> {
    Ok(controller_ended(record, live_groups)? && !unresolved_host(root, record, live_groups)?)
}

/// The native supervisor and its runtime have ended and their process group is
/// empty. This retires their ability to receive Nessie work; it does not claim
/// that an unrecorded host program or every escaped descendant has stopped.
/// Installation and the owner-account credential boundary use this proof while
/// retaining any unresolved host admission as history.
pub(crate) fn controller_ended(record: &Record, live_groups: &HashSet<i32>) -> Result<bool, NativeError> {
    let gone = |pid: i32, started: &str| match macos_processes::information(pid) {
        Ok(None) => true,
        Ok(Some(process)) => process.zombie || process.started_at != started,
        Err(_) => false,
    };
    Ok(gone(record.supervisor_pid, &record.supervisor_started_at)
        && process_group_ended(record.child_pid, &record.child_started_at, live_groups)?)
}

pub(crate) fn process_group_ended(pid: i32, started: &str, live_groups: &HashSet<i32>) -> Result<bool, NativeError> {
    let live = macos_processes::information(pid)?;
    let gone = live.as_ref().map_or(true, |process| process.zombie || process.started_at != started);
    // XNU, like every BSD, never hands out a pid that is still a process group
    // or session id. A child pid another process now holds therefore means the
    // child's group ended, and a live group with that id is the new process's.
    // On dictator three of 1888 journals met such a group and held the swap.
    let reused = live.is_some_and(|process| process.started_at != started);
    Ok(gone && (reused || !live_groups.contains(&pid)))
}

fn own_host(item: &serde_json::Value, record: &Record) -> bool {
    item["kind"] == "host_execution"
        && item["bootId"].as_str() == Some(record.boot_id.as_str())
        && item["pid"].as_i64() == Some(i64::from(record.child_pid))
        && item["startedAt"].as_str() == Some(record.child_started_at.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::managed_runtime_context;

    /// A one-shot `describe` must drop its journal while the team's daemon
    /// holds host registrations of its own, and after a restart.
    #[test]
    fn only_this_childs_host_registrations_in_this_boot_keep_its_journal() {
        let boot = "7035bda9-0000-4000-8000-000000000000";
        let record = Record { protocol_version: 1, boot_id: boot.into(), guard_version: 2, supervisor_pid: 10,
            supervisor_started_at: "1794222097171000".into(), child_pid: 11,
            child_started_at: "1794222097171534".into(), release_digest: "a".repeat(64), activity: None };
        let own = serde_json::json!({"kind":"host_execution","bootId":boot,"pid":11,"startedAt":"1794222097171534"});
        assert!(own_host(&own, &record));
        let mut others = Vec::new();
        for (key, value) in [("pid", serde_json::json!(12)),
            ("bootId", serde_json::json!("ff61df02-d264-4db7-9a2d-2fa908745780")),
            ("startedAt", serde_json::json!("1794222097171535")), ("kind", serde_json::json!("runtime"))] {
            let mut other = own.clone();
            other[key] = value;
            assert!(!own_host(&other, &record), "{key} differs");
            others.push(other);
        }
        let root = tempfile::tempdir().unwrap();
        let groups = HashSet::new();
        assert!(!unresolved_host(root.path(), &record, &groups).unwrap(), "no guard, nothing to keep");
        let guard = |registrations: &[serde_json::Value]| std::fs::write(root.path().join("guard.json"),
            serde_json::json!({"registrations": registrations}).to_string()).unwrap();
        guard(&others);
        assert!(!unresolved_host(root.path(), &record, &groups).unwrap());
        others.push(own);
        guard(&others);
        assert!(unresolved_host(root.path(), &record, &groups).unwrap(), "unbound, so unresolved");
    }

    /// A crashed runtime's registration resolves once the process it admitted,
    /// the descendants recorded with it and a group it leads are gone; an
    /// unbound one never does.
    #[test]
    fn an_admitted_process_that_ended_resolves_its_registration() {
        use serde_json::json;
        use std::os::unix::process::CommandExt;
        let mut ended = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let gone = ended.id();
        ended.wait().unwrap();
        let mut leader = std::process::Command::new("/bin/sleep").arg("30").process_group(0).spawn().unwrap();
        let live = leader.id() as i32;
        let second = (managed_runtime_context::birth(live).unwrap().parse::<u64>().unwrap() / 1_000_000).to_string();
        let groups = macos_processes::live_groups().unwrap();
        let item = |identity: serde_json::Value, descendants: serde_json::Value|
            json!({"kind":"host_execution","execution":{"identity":identity,"descendants":descendants}});
        let ended = |identity, descendants| execution_ended(&item(identity, descendants), &groups);
        assert!(!execution_ended(&json!({"kind":"host_execution"}), &groups), "unbound");
        assert!(ended(json!({"pid": gone, "startedAt": "1"}), json!([])));
        let remaining_group = HashSet::from([gone as i32]);
        assert!(!process_group_ended(gone as i32, "1", &remaining_group).unwrap(), "a remaining group fences retirement");
        assert!(process_group_ended(gone as i32, "1", &HashSet::new()).unwrap());
        assert!(ended(json!({"pid": gone}), json!([])), "pid only, and gone");
        assert!(!ended(json!({"pid": live, "startedAt": second}), json!([])), "still running");
        assert!(!ended(json!({"pid": live}), json!([])), "pid only, and a process holds it");
        assert!(ended(json!({"pid": live, "startedAt": "1"}), json!([])), "another process holds the pid");
        assert!(!ended(json!({"pid": gone, "startedAt": "1"}), json!([{"pid": live, "startedAt": second}])),
            "a recorded descendant runs");
        assert!(!ended(json!({"pid": live, "startedAt": "1", "containment": "posix_group"}), json!([])),
            "the group it led lives");
        leader.kill().unwrap();
        leader.wait().unwrap();
    }

    /// The journals earlier rules kept clear on the next launch, a crashed
    /// daemon's included; a live command's, a live daemon's and another
    /// boot's stay.
    #[test]
    fn reconcile_drops_only_ended_journals_of_this_boot() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("managed-runtimes");
        std::fs::create_dir(&directory).unwrap();
        let boot = managed_runtime_context::boot_id().unwrap();
        let mut ended = std::process::Command::new("/bin/sh").args(["-c", "IFS= read -r line"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null()).spawn().unwrap();
        let ended_pid = ended.id() as i32;
        let ended_birth = managed_runtime_context::birth(ended_pid).unwrap();
        // A release byte does not depend on unrelated forked tests closing inherited writers.
        std::io::Write::write_all(ended.stdin.as_mut().unwrap(), b"release\n").unwrap();
        drop(ended.stdin.take());
        ended.wait().unwrap();
        let own = unsafe { libc::getpid() };
        let own_birth = managed_runtime_context::birth(own).unwrap();
        let journal = |name: &str, pid: i32, birth: &str, boot: &str, activity: Option<&str>| {
            let record = Record { protocol_version: 1, boot_id: boot.into(), guard_version: 2, supervisor_pid: pid,
                supervisor_started_at: birth.into(), child_pid: pid, child_started_at: birth.into(),
                release_digest: "a".repeat(64), activity: activity.map(str::to_owned) };
            std::fs::write(directory.join(format!("{name}.json")), serde_json::to_vec(&record).unwrap()).unwrap();
            std::fs::write(directory.join(format!("{name}.sock")), b"").unwrap();
        };
        journal("ended", ended_pid, &ended_birth, &boot, None);
        journal("live", own, &own_birth, &boot, None);
        journal("daemon", ended_pid, &ended_birth, &boot, Some("serve"));
        journal("running", own, &own_birth, &boot, Some("serve"));
        journal("earlier", ended_pid, &ended_birth, "ff61df02-d264-4db7-9a2d-2fa908745780", None);
        reconcile(&directory, &boot).unwrap();
        let mut left: Vec<_> = std::fs::read_dir(&directory).unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        assert_eq!(left, ["earlier.json", "earlier.sock", "live.json", "live.sock", "running.json", "running.sock"]);
        reconcile(&root.path().join("missing"), &boot).unwrap();
        assert!(macos_processes::live_groups().unwrap().contains(&unsafe { libc::getpgrp() }),
            "the all-account snapshot sees this live group");
    }

    /// A child pid that a new process now holds, leading its own live group,
    /// does not keep an ended command's journal; the same live leader recorded
    /// as the child itself does.
    #[test]
    fn a_reused_child_pid_does_not_hold_an_ended_journal() {
        use std::os::unix::process::CommandExt;
        let root = tempfile::tempdir().unwrap();
        let boot = managed_runtime_context::boot_id().unwrap();
        let mut leader = std::process::Command::new("/bin/sleep").arg("30").process_group(0).spawn().unwrap();
        let pid = leader.id() as i32;
        let birth = managed_runtime_context::birth(pid).unwrap();
        let groups = macos_processes::live_groups().unwrap();
        assert!(groups.contains(&pid), "the new process leads its own live group");
        let record = |started: &str| Record { protocol_version: 1, boot_id: boot.clone(), guard_version: 2,
            supervisor_pid: pid, supervisor_started_at: "1".into(), child_pid: pid, child_started_at: started.into(),
            release_digest: "a".repeat(64), activity: None };
        assert!(ended_creation(&record("1"), root.path(), &groups).unwrap(), "an earlier holder of this pid");
        assert!(!ended_creation(&record(&birth), root.path(), &groups).unwrap(), "the live child itself");
        leader.kill().unwrap();
        leader.wait().unwrap();
    }
}
