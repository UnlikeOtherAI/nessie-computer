//! A newer signed release can repair a failed predecessor without discarding it.
//! Native maintenance fences remain until the replacement is verified and healthy.
use crate::{
    catalog::{compare_versions, verify_manifest, UpdateResult},
    coordinator::Coordinator,
    protocol::{PendingInstall, Phase},
};
use std::cmp::Ordering;

impl Coordinator<'_> {
    pub(crate) fn supersede(&self, now: u64) -> UpdateResult<()> {
        let preferences = self.store.preferences()?;
        let journal = self.store.journal()?;
        let Some(prior) = journal.pending.as_ref() else {
            return Ok(());
        };
        let Some(envelope) = journal.available_envelope.as_ref() else {
            return Ok(());
        };
        let Ok(next) = verify_manifest(
            envelope,
            &self.key()?,
            now as i64,
            preferences.channel,
            journal.seen.get(&preferences.channel),
        ) else {
            // Invalid fresh metadata never blocks an already accepted transaction.
            return Ok(());
        };
        let accepted = self.accepted(prior)?;
        if next.digest == prior.digest
            || compare_versions(&next.manifest.version, &accepted.manifest.version)?
                != Ordering::Greater
        {
            return Ok(());
        }
        self.store.save_superseded(&journal, &next.digest, now)?;
        self.store.mutate_journal(|current| {
            if !current.pending.as_ref().is_some_and(|pending| {
                pending.digest == prior.digest && pending.phase == prior.phase
            }) {
                return Err("update.state_unavailable");
            }
            current.pending = Some(PendingInstall {
                channel: preferences.channel,
                envelope: envelope.clone(),
                digest: next.digest,
                phase: Phase::Downloading,
                started_at: now,
            });
            current.code = None;
            current.next_install_attempt_at = now;
            Ok(())
        })?;
        Ok(())
    }
}
