//! What the tray knows, and what the icon says about it.
//!
//! The tray holds no state of its own: every poll replaces this view wholesale
//! with what the service answered, so the icon beside the clock can never be
//! showing something the service stopped believing. That is also why an
//! unreachable service is a *state* here rather than an absence — a tray that
//! silently kept its last green icon while the service was down would be the
//! worst outcome available.

use serde::{Deserialize, Serialize};

/// One paired executor, exactly as the control protocol reports it. Ids and
/// daemon states only: the service never sends a path, a key, or output, and
/// the tray has nowhere to put one.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorStatus {
    pub daemon_status: String,
    pub executor_id: String,
    pub workspace_configured: bool,
}

/// The last answer the service gave.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ServiceView {
    /// The service answered. The list may be empty: nothing is paired yet.
    Reachable { executors: Vec<ExecutorStatus> },
    /// The service is not running, refused this account, or refused to
    /// supervise anything — an unsigned build, a tampered runtime, no Hyper-V.
    Unreachable { reason: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayState {
    /// Nothing paired: the service is fine, there is just nothing to run.
    Idle,
    /// At least one daemon is running.
    Running,
    /// Something is mid-flight: connecting, awaiting fingerprint confirmation,
    /// or a daemon still tearing its guests down.
    Attention,
    /// The service could not be reached or could not supervise.
    Error,
}

impl TrayState {
    /// The compiled-in icon for this state. The bytes travel inside the
    /// executable so a file swapped in `Program Files` cannot repaint the tray
    /// green while the runtime is refusing to start.
    pub fn icon_bytes(self) -> &'static [u8] {
        match self {
            Self::Idle => include_bytes!("../icons/tray-idle.png"),
            Self::Running => include_bytes!("../icons/tray-running.png"),
            Self::Attention => include_bytes!("../icons/tray-attention.png"),
            Self::Error => include_bytes!("../icons/tray-error.png"),
        }
    }
}

/// Red beats amber beats green beats grey: the icon reports the most demanding
/// thing true right now, because a person glances at it rather than reading it.
pub fn tray_state(view: &ServiceView) -> TrayState {
    let ServiceView::Reachable { executors } = view else {
        return TrayState::Error;
    };
    if executors.iter().any(|executor| {
        matches!(
            executor.daemon_status.as_str(),
            "starting" | "stopping" | "awaiting_confirmation"
        )
    }) {
        return TrayState::Attention;
    }
    if executors.iter().any(|executor| executor.daemon_status == "running") {
        return TrayState::Running;
    }
    // Paired but stopped reads the same as nothing paired, deliberately: grey
    // means "no executor is working for you right now", which is the one thing
    // a glance at the clock needs to answer. The menu says which of the two it
    // is, and stopping something on purpose must not light the tray up.
    TrayState::Idle
}

/// Folder sync that needs the person — a conflict, held deletions, a missing
/// folder, an Allow in Nessie — is amber too, over green or grey; it never
/// hides a red service.
pub fn with_sync(state: TrayState, sync_needs_you: bool) -> TrayState {
    if sync_needs_you && matches!(state, TrayState::Idle | TrayState::Running) {
        TrayState::Attention
    } else {
        state
    }
}

/// The disabled first line of the menu. It says what the icon means, because a
/// colour alone cannot name a remedy.
pub fn header_label(view: &ServiceView) -> String {
    match view {
        ServiceView::Unreachable { reason } => format!("Nessie Executor — {reason}"),
        ServiceView::Reachable { executors } if executors.is_empty() => {
            "Nessie Executor — nothing paired".to_owned()
        }
        ServiceView::Reachable { executors } => {
            let running =
                executors.iter().filter(|executor| executor.daemon_status == "running").count();
            format!("Nessie Executor — {running} of {} running", executors.len())
        }
    }
}

/// Enough of an executor id to tell two apart in a menu, and never so much that
/// the menu grows a horizontal scrollbar. Ids are UUIDs; the first segment is
/// what a person compares against the Executors page.
pub fn short_id(executor_id: &str) -> String {
    executor_id.split('-').next().unwrap_or(executor_id).to_owned()
}

#[cfg(test)]
mod tests {
    use super::{header_label, short_id, tray_state, with_sync, ExecutorStatus, ServiceView, TrayState};

    fn executor(daemon_status: &str) -> ExecutorStatus {
        ExecutorStatus {
            daemon_status: daemon_status.to_owned(),
            executor_id: "00000000-0000-4000-8000-000000000001".to_owned(),
            workspace_configured: true,
        }
    }

    fn reachable(states: &[&str]) -> ServiceView {
        ServiceView::Reachable { executors: states.iter().map(|state| executor(state)).collect() }
    }

    #[test]
    fn nothing_paired_is_grey_and_says_so() {
        let view = reachable(&[]);
        assert_eq!(tray_state(&view), TrayState::Idle);
        assert_eq!(header_label(&view), "Nessie Executor — nothing paired");
    }

    #[test]
    fn a_running_daemon_is_green() {
        let view = reachable(&["running", "stopped"]);
        assert_eq!(tray_state(&view), TrayState::Running);
        assert_eq!(header_label(&view), "Nessie Executor — 1 of 2 running");
    }

    /// Amber outranks green: a person watching for a daemon to finish tearing
    /// down must not see the icon claim everything is running.
    #[test]
    fn work_in_flight_outranks_a_running_daemon() {
        assert_eq!(tray_state(&reachable(&["running", "stopping"])), TrayState::Attention);
        assert_eq!(
            tray_state(&reachable(&["awaiting_confirmation", "running"])),
            TrayState::Attention,
        );
        assert_eq!(tray_state(&reachable(&["starting", "running"])), TrayState::Attention);
    }

    /// The state that must never be mistaken for any other, and the one a
    /// cached last-known-good icon would hide.
    #[test]
    fn an_unreachable_service_is_red_and_the_reason_reaches_the_menu() {
        let view = ServiceView::Unreachable {
            reason: "the packaged runtime did not pass integrity verification".to_owned(),
        };
        assert_eq!(tray_state(&view), TrayState::Error);
        assert_eq!(
            header_label(&view),
            "Nessie Executor — the packaged runtime did not pass integrity verification",
        );
    }

    #[test]
    fn sync_that_needs_the_person_is_amber_but_never_hides_red() {
        assert_eq!(with_sync(TrayState::Running, true), TrayState::Attention);
        assert_eq!(with_sync(TrayState::Idle, true), TrayState::Attention);
        assert_eq!(with_sync(TrayState::Error, true), TrayState::Error);
        assert_eq!(with_sync(TrayState::Running, false), TrayState::Running);
    }

    #[test]
    fn every_state_carries_a_distinct_icon() {
        let icons = [
            TrayState::Idle.icon_bytes(),
            TrayState::Running.icon_bytes(),
            TrayState::Attention.icon_bytes(),
            TrayState::Error.icon_bytes(),
        ];
        for (index, icon) in icons.iter().enumerate() {
            assert!(icon.starts_with(b"\x89PNG"), "icon {index} must be a PNG");
            for (other, candidate) in icons.iter().enumerate() {
                assert!(index == other || icon != candidate, "icons {index} and {other} match");
            }
        }
    }

    #[test]
    fn a_menu_line_shows_enough_of_an_id_to_tell_two_apart() {
        assert_eq!(short_id("1f2e3d4c-0000-4000-8000-000000000001"), "1f2e3d4c");
        assert_eq!(short_id("plain"), "plain");
    }
}
