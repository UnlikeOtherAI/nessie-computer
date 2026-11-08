//! What the tray knows, and what the icon says about it.
//!
//! The tray holds no state of its own: every poll replaces this view wholesale
//! with what the service and this app's own connections answered, so the icon
//! beside the clock can never be showing something they stopped believing.
//! That is also why an unreachable service is a *state* here rather than an
//! absence — a tray that silently kept its last icon while the service was
//! down would be the worst outcome available.

use nessie_windows_common::failure::Failure;
use serde::{Deserialize, Serialize};

/// Who runs a team's connection on this computer: this app, under the
/// person's own account, or the Windows service. ChatGPT plans need the
/// service, because only it can hold their sign-in in custody.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Connection {
    User,
    #[default]
    Service,
}

/// One paired team connection. Ids, states and counts only: the service never
/// sends a path, a key, or output, and the tray has nowhere to put one.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorStatus {
    pub daemon_status: String,
    pub executor_id: String,
    pub workspace_configured: bool,
    /// The owner paused this team. Its daemon stays connected and refuses new work.
    pub paused: bool,
    /// Why the connection last stopped, while it is not running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<Failure>,
    pub pending_program_requests: usize,
    /// Filled in by the tray after it merges both lists; never sent by the service.
    #[serde(default)]
    pub connection: Connection,
    /// On a team this app runs: the service connection to the same team that
    /// holds its ChatGPT plans, when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chatgpt_connection_id: Option<String>,
}

impl ExecutorStatus {
    /// Connected and not paused. A team another app or the CLI runs here is
    /// working too: it is connected, just not by this app.
    pub fn working(&self) -> bool {
        !self.paused
            && matches!(self.daemon_status.as_str(), "running" | crate::user_connections::RUNNING_ELSEWHERE)
    }
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
    /// Nothing connected, or everything paused.
    Idle,
    /// At least one team is connected and working.
    Working,
    /// Something only the owner can settle: a program request, documents that
    /// need a decision, a failure with a fix, an owner confirmation.
    NeedsYou,
    /// The background service could not be reached.
    Error,
}

impl TrayState {
    /// The compiled-in icon for this state. The bytes travel inside the
    /// executable so a file swapped in `Program Files` cannot repaint the tray
    /// while the runtime is refusing to start.
    pub fn icon_bytes(self) -> &'static [u8] {
        match self {
            Self::Idle => include_bytes!("../icons/tray-idle.png"),
            Self::Working => include_bytes!("../icons/tray-running.png"),
            Self::NeedsYou => include_bytes!("../icons/tray-attention.png"),
            Self::Error => include_bytes!("../icons/tray-error.png"),
        }
    }
}

/// Red beats amber beats green beats grey. Connecting, starting and stopping
/// are never amber: amber means the owner has something to do.
pub fn tray_state(view: &ServiceView, needs_you: bool) -> TrayState {
    let ServiceView::Reachable { executors } = view else {
        return TrayState::Error;
    };
    if needs_you {
        TrayState::NeedsYou
    } else if executors.iter().any(ExecutorStatus::working) {
        TrayState::Working
    } else {
        TrayState::Idle
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::{tray_state, Connection, ExecutorStatus, ServiceView, TrayState};

    pub(crate) fn executor(id: &str, daemon_status: &str, paused: bool) -> ExecutorStatus {
        ExecutorStatus {
            daemon_status: daemon_status.to_owned(),
            executor_id: id.to_owned(),
            workspace_configured: true,
            paused,
            failure: None,
            pending_program_requests: 0,
            connection: Connection::User,
            chatgpt_connection_id: None,
        }
    }

    fn reachable(states: &[(&str, bool)]) -> ServiceView {
        ServiceView::Reachable {
            executors: states.iter().enumerate()
                .map(|(index, (state, paused))| executor(&format!("team-{index}"), state, *paused)).collect(),
        }
    }

    #[test]
    fn grey_means_nothing_is_working_for_you_right_now() {
        assert_eq!(tray_state(&reachable(&[]), false), TrayState::Idle);
        assert_eq!(tray_state(&reachable(&[("running", true), ("running", true)]), false), TrayState::Idle);
        assert_eq!(tray_state(&reachable(&[("stopped", false)]), false), TrayState::Idle);
        // Connecting is never amber.
        assert_eq!(tray_state(&reachable(&[("starting", false), ("stopping", false)]), false), TrayState::Idle);
    }

    #[test]
    fn a_connected_team_that_is_not_paused_is_working() {
        assert_eq!(tray_state(&reachable(&[("running", true), ("running", false)]), false), TrayState::Working);
        assert_eq!(tray_state(&reachable(&[("running elsewhere", false)]), false), TrayState::Working);
    }

    #[test]
    fn amber_is_only_for_the_owner_and_never_hides_red() {
        assert_eq!(tray_state(&reachable(&[("running", false)]), true), TrayState::NeedsYou);
        let unreachable = ServiceView::Unreachable { reason: "the service could not be reached".to_owned() };
        assert_eq!(tray_state(&unreachable, true), TrayState::Error);
    }

    #[test]
    fn a_service_row_decodes_without_tray_only_fields() {
        let row: ExecutorStatus = serde_json::from_value(serde_json::json!({
            "daemonStatus": "stopped", "executorId": "a-1", "workspaceConfigured": true, "paused": false,
            "failure": { "code": "EXECUTOR_CONNECTION_FENCED", "message": "Executor connection is fenced." },
            "pendingProgramRequests": 1,
        })).unwrap();
        assert_eq!(row.connection, Connection::Service);
        assert_eq!(row.failure.unwrap().code.as_deref(), Some("EXECUTOR_CONNECTION_FENCED"));
        let missing = serde_json::from_value::<ExecutorStatus>(serde_json::json!({
            "daemonStatus": "running", "executorId": "a-1", "workspaceConfigured": true,
        }));
        assert!(missing.is_err(), "paused and pendingProgramRequests are required");
    }

    #[test]
    fn every_state_carries_a_distinct_icon() {
        let icons = [TrayState::Idle, TrayState::Working, TrayState::NeedsYou, TrayState::Error]
            .map(TrayState::icon_bytes);
        for (index, icon) in icons.iter().enumerate() {
            assert!(icon.starts_with(b"\x89PNG"), "icon {index} must be a PNG");
            for (other, candidate) in icons.iter().enumerate() {
                assert!(index == other || icon != candidate, "icons {index} and {other} match");
            }
        }
    }
}
