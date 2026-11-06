//! Windows native update boundaries: protected runtime, MSI installation and fresh health.
#[path = "windows_clearance.rs"]
mod clearance;
#[path = "windows_health.rs"]
mod health;
#[path = "windows_package.rs"]
mod package;
#[path = "windows_runtime.rs"]
mod runtime;
#[path = "windows_service_setup.rs"]
mod setup;
pub(in crate::updates) use health::{confirm_restarted, observe_daemon};
pub(in crate::updates) use package::{replace_when_clear, verify_publishers};
pub(in crate::updates) use runtime::{initialize, installed, target, verify_worker, worker_image};
