//! Recovery when the installed runtime already meets an accepted transaction.
//!
//! A newer app can bring its own runtime: on macOS the approved helper installs
//! it from the sealed app. A waiting transaction for the same or an older
//! version can then never install, because monotonic versions refuse it. It is
//! archived with its history, never replayed or deleted, and its drain ends.
use crate::{
    catalog::{compare_versions, UpdateResult},
    coordinator::{Coordinator, Installed},
    protocol::Phase,
    storage::{Journal, Store},
};
use std::{cmp::Ordering, fs};

/// What a newer app's own runtime does for an older installed factory.
#[derive(Debug, PartialEq, Eq)]
pub enum ApplicationPlan {
    /// Nothing newer to bring, or a started replacement owns the machine.
    Keep,
    /// Install the app's runtime once the machine is clear. `persistent` means
    /// admissions are already held for nothing newer than the app, so waiting
    /// for clearance keeps back no work that could otherwise start.
    Install { persistent: bool },
}

/// `pending` is the accepted transaction's phase and verified version.
pub fn application_plan(
    installed: &str,
    application: &str,
    pending: Option<(Phase, &str)>,
    replacing: bool,
    draining: bool,
) -> UpdateResult<ApplicationPlan> {
    if replacing
        || pending.is_some_and(|(phase, _)| matches!(phase, Phase::Installing | Phase::Restarting))
    {
        return Ok(ApplicationPlan::Keep);
    }
    if compare_versions(application, installed)? != Ordering::Greater {
        return Ok(ApplicationPlan::Keep);
    }
    let covered = match pending {
        None => true,
        Some((_, version)) => compare_versions(version, application)? != Ordering::Greater,
    };
    Ok(ApplicationPlan::Install {
        persistent: draining && covered,
    })
}

impl Store {
    fn save_retired(&self, journal: &Journal, installed: &Installed, now: u64) -> UpdateResult<()> {
        let prior = journal.pending.as_ref().ok_or("update.state_unavailable")?;
        if prior.digest.len() != 64 || !prior.digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("update.invalid_manifest");
        }
        let root = self.root().join("retired");
        fs::create_dir_all(&root).map_err(|_| "update.state_unavailable")?;
        let entry = fs::symlink_metadata(&root).map_err(|_| "update.state_unavailable")?;
        if !entry.is_dir() || entry.file_type().is_symlink() {
            return Err("update.state_unavailable");
        }
        let archive = Store::new(root);
        let name = format!("{}.json", prior.digest);
        let transaction = serde_json::to_value(prior).map_err(|_| "update.state_unavailable")?;
        if let Some(existing) = archive.read::<serde_json::Value>(&name)? {
            return if existing["transaction"] == transaction {
                Ok(())
            } else {
                Err("update.state_unavailable")
            };
        }
        archive.write(
            &name,
            &serde_json::json!({ "transaction":transaction, "retiredAt":now,
                "installedVersion":installed.version, "installedSourceCommit":installed.source_commit,
                "failureCode":journal.code, "installFailures":journal.install_failures,
                "requestId":journal.request_id }),
        )
    }
}

impl Coordinator<'_> {
    /// The accepted transaction's phase and version, from its original signed bytes.
    pub fn accepted_pending(&self) -> UpdateResult<Option<(Phase, String)>> {
        let journal = self.store.journal()?;
        let Some(pending) = journal.pending.as_ref() else {
            return Ok(None);
        };
        Ok(Some((pending.phase, self.accepted(pending)?.manifest.version)))
    }

    /// Archive a downloading or waiting transaction the installed runtime
    /// already meets. Started replacements stay with their worker.
    pub fn retire_obsolete(&self, now: u64) -> UpdateResult<bool> {
        let journal = self.store.journal()?;
        let Some(pending) = journal.pending.clone() else {
            return Ok(false);
        };
        if !matches!(pending.phase, Phase::Downloading | Phase::Waiting) {
            return Ok(false);
        }
        let accepted = self.accepted(&pending)?;
        let installed = self.installer.installed()?;
        if compare_versions(&accepted.manifest.version, &installed.version)? == Ordering::Greater {
            return Ok(false);
        }
        self.store.save_retired(&journal, &installed, now)?;
        let mut retired = false;
        self.store.mutate_journal(|current| {
            // Another writer may have moved on meanwhile; that state is newer.
            if !current.pending.as_ref().is_some_and(|value| {
                value.digest == pending.digest
                    && matches!(value.phase, Phase::Downloading | Phase::Waiting)
            }) {
                return Ok(());
            }
            current.pending = None;
            current.code = None;
            if current.request_id == journal.request_id {
                current.manual = false;
            }
            retired = true;
            Ok(())
        })?;
        Ok(retired)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_newer_app_installs_its_runtime_only_over_an_older_unstarted_factory() {
        use ApplicationPlan::*;
        let plan = |installed, pending, replacing, draining| {
            application_plan(installed, "1.0.16", pending, replacing, draining).unwrap()
        };
        // The live Mac: old factory, drain held for an older stage.
        assert_eq!(plan("0.9.0", Some((Phase::Waiting, "1.0.13")), false, true), Install { persistent: true });
        assert_eq!(plan("0.9.0", None, false, true), Install { persistent: true });
        assert_eq!(plan("0.9.0", Some((Phase::Downloading, "1.0.16")), false, true), Install { persistent: true });
        // Healthy machines are never held back for long.
        assert_eq!(plan("1.0.15", None, false, false), Install { persistent: false });
        assert_eq!(plan("0.9.0", Some((Phase::Waiting, "1.0.20")), false, true), Install { persistent: false });
        // Monotonic: never the same or an older runtime.
        assert_eq!(plan("1.0.16", None, false, false), Keep);
        assert_eq!(plan("1.0.17", None, false, false), Keep);
        // A started replacement belongs to its worker.
        assert_eq!(plan("0.9.0", Some((Phase::Installing, "1.0.13")), false, true), Keep);
        assert_eq!(plan("0.9.0", Some((Phase::Restarting, "1.0.13")), false, true), Keep);
        assert_eq!(plan("0.9.0", None, true, true), Keep);
        assert!(application_plan("0.9", "1.0.16", None, false, false).is_err());
    }
}
