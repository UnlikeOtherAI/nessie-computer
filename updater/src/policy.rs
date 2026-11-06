use crate::{catalog::UpdateResult, storage::Preferences};

pub(crate) fn active_transaction(
    preferences: &Preferences,
    journal: &crate::storage::Journal,
) -> bool {
    use crate::protocol::Phase;
    journal.pending.as_ref().is_some_and(|pending| {
        preferences.automatic
            || journal.manual
            || matches!(pending.phase, Phase::Installing | Phase::Restarting)
    })
}

pub(crate) fn draining(preferences: &Preferences, journal: &crate::storage::Journal) -> bool {
    use crate::protocol::Phase;
    active_transaction(preferences, journal)
        && journal.pending.as_ref().is_some_and(|pending| {
            matches!(
                pending.phase,
                Phase::Waiting | Phase::Installing | Phase::Restarting
            )
        })
}

pub fn should_notify(preferences: &Preferences, version: &str, now: u64) -> bool {
    !preferences.automatic
        && (preferences.reminded_version.as_deref() != Some(version)
            || preferences.remind_after.unwrap_or(0) <= now)
}

pub fn remind_tomorrow(preferences: &mut Preferences, version: &str, now: u64) -> UpdateResult<()> {
    crate::catalog::version(version)?;
    preferences.reminded_version = Some(version.to_owned());
    preferences.remind_after = Some(now.saturating_add(86_400_000));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{catalog::compare_versions, protocol::Channel};
    use std::cmp::Ordering;

    #[test]
    fn defaults_are_automatic_and_stable() {
        let preferences = Preferences::default();
        assert!(preferences.automatic);
        assert_eq!(preferences.channel, Channel::Stable);
        assert!(!should_notify(&preferences, "1.0.1", 100));
    }

    #[test]
    fn reminders_expire_after_one_day_and_new_versions_are_not_suppressed() {
        let mut preferences = Preferences {
            automatic: false,
            ..Preferences::default()
        };
        remind_tomorrow(&mut preferences, "1.0.2", 100).unwrap();
        assert!(!should_notify(&preferences, "1.0.2", 101));
        assert!(should_notify(&preferences, "1.0.2", 86_400_100));
        assert!(should_notify(&preferences, "1.0.3", 101));
        assert!(!preferences.automatic);
    }

    #[test]
    fn version_order_survives_repository_history_reset() {
        assert_eq!(
            compare_versions("1.0.0", "0.0.65000"),
            Ok(Ordering::Greater)
        );
        assert_eq!(compare_versions("1.0.12", "1.0.9"), Ok(Ordering::Greater));
        assert!(compare_versions("1.0", "1.0.0").is_err());
    }
}
