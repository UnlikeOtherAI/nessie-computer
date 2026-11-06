//! Keep the service and its recovery entry point outside the package being replaced.
use nessie_executor_updater::catalog::UpdateResult;
use std::{path::Path, time::Duration};
use windows_service::{
    service::{
        ServiceAccess, ServiceAction, ServiceActionType, ServiceErrorControl,
        ServiceFailureActions, ServiceFailureResetPeriod, ServiceInfo, ServiceStartType,
        ServiceType,
    },
    service_manager::{ServiceManager, ServiceManagerAccess},
};

pub(super) fn configure(worker: &Path) -> UpdateResult<()> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|_| "update.service_configuration_failed")?;
    let service = manager
        .open_service("NessieExecutorUpdater", ServiceAccess::CHANGE_CONFIG)
        .map_err(|_| "update.service_configuration_failed")?;
    service
        .change_config(&ServiceInfo {
            name: "NessieExecutorUpdater".into(),
            display_name: "Nessie Computer Updates".into(),
            service_type: ServiceType::OWN_PROCESS,
            start_type: ServiceStartType::AutoStart,
            error_control: ServiceErrorControl::Normal,
            executable_path: worker.to_path_buf(),
            launch_arguments: vec!["update-service".into()],
            dependencies: vec![],
            account_name: None,
            account_password: None,
        })
        .map_err(|_| "update.service_configuration_failed")?;
    service
        .update_failure_actions(ServiceFailureActions {
            reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(86_400)),
            reboot_msg: None,
            command: None,
            actions: Some(vec![ServiceAction {
                action_type: ServiceActionType::Restart,
                delay: Duration::from_secs(30),
            }]),
        })
        .map_err(|_| "update.service_configuration_failed")?;
    service
        .set_failure_actions_on_non_crash_failures(true)
        .map_err(|_| "update.service_configuration_failed")
}
