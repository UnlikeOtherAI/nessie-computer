//! The authenticated local transport passes only these fixed vendor operations.
use crate::{
    catalog::UpdateResult,
    coordinator::Coordinator,
    policy::remind_tomorrow,
    protocol::{Request, Status},
};

impl Coordinator<'_> {
    pub fn control(&self, request: Request, now: u64) -> UpdateResult<Status> {
        if !self.store.installation_enabled()? { return Err("update.installation_removed"); }
        match request {
            Request::Status => {}
            Request::Channel { channel } => {
                self.store.mutate_journal(|journal| {
                    if self.store.preferences()?.channel == channel {
                        return Ok(());
                    }
                    if journal.pending.is_some() {
                        return Err("update.installation_in_progress");
                    }
                    self.store.mutate_preferences(|preferences| {
                        preferences.channel = channel;
                        Ok(())
                    })?;
                    journal.available_envelope = None;
                    journal.last_checked_at = None;
                    journal.check_requested_at = Some(now);
                    journal.check_code = None;
                    journal.next_check_at = now;
                    Ok(())
                })?;
            }
            Request::Check => {
                self.store.mutate_journal(|journal| {
                    journal.check_requested_at = Some(now);
                    Ok(())
                })?;
            }
            Request::Automatic { enabled } => {
                self.store.mutate_preferences(|preferences| {
                    preferences.automatic = enabled;
                    Ok(())
                })?;
            }
            Request::Remind => {
                let status = self.status(now)?;
                let version = status
                    .available_version
                    .ok_or("update.no_update_available")?;
                self.store.mutate_preferences(|preferences| {
                    remind_tomorrow(preferences, &version, now)
                })?;
            }
            Request::Install => {
                // A local choice has its own idempotency key; the service never
                // accepts a caller's release, download URL or executable path.
                self.request_install(&uuid::Uuid::new_v4().to_string())?;
                self.store.mutate_journal(|journal| {
                    journal.check_requested_at = Some(now);
                    Ok(())
                })?;
            }
            Request::Request { request } => {
                if request.requested_at.len() > 32
                    || !request.requested_at.ends_with('Z')
                    || chrono::DateTime::parse_from_rfc3339(&request.requested_at).is_err()
                {
                    return Err("update.invalid_request");
                }
                self.request_install(&request.request_id)?;
                self.store.mutate_journal(|journal| {
                    if journal.pending.is_none() {
                        journal.check_requested_at = Some(now);
                    }
                    Ok(())
                })?;
            }
        }
        self.status(now)
    }
}
