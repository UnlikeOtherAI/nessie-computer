//! Project protected state through the same bounded contract as the app and heartbeat.
use crate::{
    catalog::{compare_versions, release_key, verify_manifest, UpdateResult},
    coordinator::Coordinator,
    policy::should_notify,
    protocol::{Phase, Status},
};
use std::cmp::Ordering;

impl Coordinator<'_> {
    pub fn status(&self, now: u64) -> UpdateResult<Status> {
        let preferences = self.store.preferences()?;
        let journal = self.store.journal()?;
        let installed = self.installer.installed()?;
        let available = journal
            .available_envelope
            .as_ref()
            .and_then(|envelope| {
                verify_manifest(
                    envelope,
                    &release_key().ok()?,
                    now as i64,
                    preferences.channel,
                    journal.seen.get(&preferences.channel),
                )
                .ok()
            })
            .filter(|value| {
                compare_versions(&value.manifest.version, &installed.version)
                    == Ok(Ordering::Greater)
            });
        let version = available.map(|value| value.manifest.version);
        let phase = if journal.code.is_some() {
            Phase::Failed
        } else if let Some(pending) = &journal.pending {
            pending.phase
        } else if journal.check_requested_at.is_some() || journal.last_checked_at.is_none() {
            Phase::Checking
        } else if version.is_some() {
            Phase::Available
        } else {
            Phase::Idle
        };
        Ok(Status {
            format: 1,
            automatic: preferences.automatic,
            channel: preferences.channel,
            installed_version: installed.version,
            source_commit: installed.source_commit,
            can_install: self.installer.target().is_ok(),
            phase,
            notify: version
                .as_ref()
                .is_some_and(|version| should_notify(&preferences, version, now)),
            available_version: version,
            last_checked_at: journal
                .last_checked_at
                .and_then(|time| chrono::DateTime::from_timestamp_millis(time as i64))
                .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
            request_id: journal.request_id,
            code: journal.code,
        })
    }
}
