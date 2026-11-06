//! One native worker drives durable retries; local controls never wait for the network.
use crate::{catalog::UpdateResult, coordinator::Coordinator};

const SIX_HOURS: u64 = 21_600_000;

fn retry_delay(failures: u32) -> u64 {
    15_000_u64
        .saturating_mul(1_u64 << failures.min(5))
        .min(300_000)
}

fn jitter() -> u64 {
    (uuid::Uuid::new_v4().as_u128() % 1_800_001) as u64
}

impl Coordinator<'_> {
    /// Accepted transactions resume even when a fresh catalogue check is offline.
    pub fn tick(&self, now: u64) -> UpdateResult<()> {
        let _worker = self.store.worker()?;
        let journal = self.store.journal()?;
        let check_due = journal.next_check_at <= now
            || journal
                .check_requested_at
                .is_some_and(|at| at > journal.last_check_attempt_at);
        if check_due {
            // Persist the attempt before I/O. A reboot during a failed connection
            // cannot turn the durable install intent into an endless tight loop.
            self.store.mutate_journal(|current| {
                current.next_check_at = now.saturating_add(30_000);
                current.last_check_attempt_at = now;
                Ok(())
            })?;
            let result = self.check(now);
            self.store.mutate_journal(|current| {
                match result {
                    Ok(()) => {
                        current.check_failures = 0;
                        current.next_check_at = now.saturating_add(SIX_HOURS - 900_000 + jitter());
                    }
                    Err(code) => {
                        current.check_failures = current.check_failures.saturating_add(1);
                        current.next_check_at =
                            now.saturating_add(retry_delay(current.check_failures));
                        current.check_code = Some(code.into());
                    }
                }
                Ok(())
            })?;
        }
        let journal = self.store.journal()?;
        if journal.next_install_attempt_at > now {
            return Ok(());
        }
        let result = self.advance(now);
        self.store.mutate_journal(|current| {
            match result {
                Ok(()) => {
                    current.install_failures = 0;
                    current.next_install_attempt_at = now.saturating_add(1_000);
                }
                Err(code) => {
                    current.install_failures = current.install_failures.saturating_add(1);
                    current.next_install_attempt_at =
                        now.saturating_add(retry_delay(current.install_failures));
                    current.code = Some(code.into());
                }
            }
            Ok(())
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn offline_retries_are_bounded_and_never_overflow() {
        assert_eq!(retry_delay(1), 30_000);
        assert_eq!(retry_delay(2), 60_000);
        assert_eq!(retry_delay(u32::MAX), 300_000);
        assert!(jitter() <= 1_800_000);
    }
}
