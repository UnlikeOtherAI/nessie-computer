//! A drain is a bounded attempt, never an indefinite fence.
//!
//! Waiting for work to finish holds new team starts back for one window. If the
//! machine is not clear by then, admissions reopen and the same accepted
//! transaction tries again after a pause. Nothing running is stopped or
//! cancelled. Installing and Restarting keep the fence: once replacement has
//! begun, nothing older may start.
use crate::{
    catalog::UpdateResult,
    policy,
    protocol::Phase,
    storage::{Journal, Preferences, Store},
};
use serde::{Deserialize, Serialize};

/// How long one attempt may hold new work back while existing work finishes.
pub const WINDOW: u64 = 3_600_000;
/// How long teams start normally before the next attempt.
pub const PAUSE: u64 = 21_600_000;
const FILE: &str = "drain.json";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Attempt {
    format: u32,
    transaction: String,
    started_at: u64,
}

/// Inside one of the repeating attempt windows, counted from the transaction's
/// first drain. A clock that moved backwards counts as the first window.
pub fn open(started_at: u64, now: u64) -> bool {
    now.saturating_sub(started_at) % (WINDOW + PAUSE) < WINDOW
}

impl Store {
    fn drain_started(&self, digest: &str) -> Option<u64> {
        // A damaged record only restarts the attempt; it never fences admissions
        // indefinitely or blocks the accepted transaction.
        self.read::<Attempt>(FILE)
            .ok()
            .flatten()
            .filter(|attempt| attempt.format == 1 && attempt.transaction == digest)
            .map(|attempt| attempt.started_at)
    }

    /// Whether admissions are held now. Status, the worker and the waiting
    /// installer share this answer; it never writes.
    pub fn draining(
        &self,
        preferences: &Preferences,
        journal: &Journal,
        now: u64,
    ) -> UpdateResult<bool> {
        if !policy::draining(preferences, journal) {
            return Ok(false);
        }
        let Some(pending) = &journal.pending else {
            return Ok(false);
        };
        if pending.phase != Phase::Waiting {
            return Ok(true);
        }
        // Until the worker records the first drain, this is that first window.
        Ok(self
            .drain_started(&pending.digest)
            .is_none_or(|started| open(started, now)))
    }

    /// The worker records when a waiting transaction first drained, once.
    pub(crate) fn begin_drain(
        &self,
        preferences: &Preferences,
        journal: &Journal,
        now: u64,
    ) -> UpdateResult<()> {
        let Some(pending) = journal.pending.as_ref().filter(|pending| {
            pending.phase == Phase::Waiting && policy::draining(preferences, journal)
        }) else {
            return Ok(());
        };
        if self.drain_started(&pending.digest).is_some() {
            return Ok(());
        }
        self.write(
            FILE,
            &Attempt {
                format: 1,
                transaction: pending.digest.clone(),
                started_at: now,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Channel, PendingInstall};

    fn waiting(digest: &str) -> Journal {
        Journal {
            format: 1,
            pending: Some(PendingInstall {
                channel: Channel::Preview,
                envelope: String::new(),
                digest: digest.into(),
                phase: Phase::Waiting,
                started_at: 0,
            }),
            ..Journal::default()
        }
    }

    #[test]
    fn a_waiting_drain_ends_after_its_window_and_retries_after_the_pause() {
        assert!(open(1_000, 1_000));
        assert!(open(1_000, 1_000 + WINDOW - 1));
        assert!(!open(1_000, 1_000 + WINDOW));
        assert!(!open(1_000, 1_000 + WINDOW + PAUSE - 1));
        assert!(open(1_000, 1_000 + WINDOW + PAUSE));
        assert!(open(1_000, 0), "a clock moved backwards stays in the first window");
    }

    #[test]
    fn only_the_waiting_phase_is_bounded_and_the_first_drain_is_recorded_once() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().to_path_buf());
        let preferences = Preferences::default();
        let mut journal = waiting(&"a".repeat(64));
        assert!(store.draining(&preferences, &journal, 50).unwrap());
        store.begin_drain(&preferences, &journal, 50).unwrap();
        store.begin_drain(&preferences, &journal, 90).unwrap();
        assert!(store.draining(&preferences, &journal, 50 + WINDOW - 1).unwrap());
        assert!(!store.draining(&preferences, &journal, 50 + WINDOW).unwrap());
        for phase in [Phase::Installing, Phase::Restarting] {
            journal.pending.as_mut().unwrap().phase = phase;
            assert!(store.draining(&preferences, &journal, 50 + WINDOW).unwrap());
        }
        // A different transaction starts its own first window.
        let next = waiting(&"b".repeat(64));
        assert!(store.draining(&preferences, &next, 50 + WINDOW).unwrap());
        fs_damage(&store);
        assert!(store.draining(&preferences, &next, 50 + WINDOW).unwrap());
        store.begin_drain(&preferences, &next, 7).unwrap();
        assert!(!store.draining(&preferences, &next, 7 + WINDOW).unwrap());
        assert!(!store
            .draining(&preferences, &Journal { format: 1, ..Journal::default() }, 0)
            .unwrap());
    }

    fn fs_damage(store: &Store) {
        std::fs::write(store.root().join(FILE), b"{not json").unwrap();
    }
}
