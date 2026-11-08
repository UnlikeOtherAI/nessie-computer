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
    configure_service("NessieExecutorUpdater", "Nessie Computer Updates", worker)
}

fn configure_service(name: &str, display_name: &str, worker: &Path) -> UpdateResult<()> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|_| "update.service_configuration_failed")?;
    let service = manager
        .open_service(name, ServiceAccess::CHANGE_CONFIG | ServiceAccess::START)
        .map_err(|_| "update.service_configuration_failed")?;
    service
        .change_config(&ServiceInfo {
            name: name.into(),
            display_name: display_name.into(),
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
        .map_err(|_| "update.service_recovery_configuration_failed")?;
    service
        .set_failure_actions_on_non_crash_failures(true)
        .map_err(|_| "update.service_recovery_configuration_failed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_service::service::Service;

    struct RemoveService(Service);
    impl Drop for RemoveService {
        fn drop(&mut self) {
            let _ = self.0.delete();
        }
    }

    #[test]
    fn recovery_configuration_has_restart_access_and_never_starts_the_fixture() {
        let root = tempfile::tempdir().unwrap();
        // The target never exists. No test executable can run as a service,
        // including if the test machine reboots before cleanup.
        let worker = root.path().join("never-started.exe");
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let name = format!("NessieUpdaterSetupTest-{}-{nonce}", std::process::id());
        let manager = ServiceManager::local_computer(
            None::<&str>,
            ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
        )
        .unwrap();
        let fixture = RemoveService(
            manager
                .create_service(
                    &ServiceInfo {
                        name: name.clone().into(),
                        display_name: name.clone().into(),
                        service_type: ServiceType::OWN_PROCESS,
                        start_type: ServiceStartType::OnDemand,
                        error_control: ServiceErrorControl::Normal,
                        executable_path: worker.clone(),
                        launch_arguments: vec![],
                        dependencies: vec![],
                        account_name: None,
                        account_password: None,
                    },
                    ServiceAccess::DELETE | ServiceAccess::QUERY_CONFIG,
                )
                .unwrap(),
        );
        configure_service(&name, &name, &worker)
            .expect("restart actions require SERVICE_START on the handle");
        assert_eq!(
            fixture.0.query_config().unwrap().start_type,
            ServiceStartType::AutoStart
        );
        let actions = fixture.0.get_failure_actions().unwrap().actions.unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].action_type, ServiceActionType::Restart);
        assert_eq!(actions[0].delay, Duration::from_secs(30));
        assert!(fixture
            .0
            .get_failure_actions_on_non_crash_failures()
            .unwrap());
    }
}
