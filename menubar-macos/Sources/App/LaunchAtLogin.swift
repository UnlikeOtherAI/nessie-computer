import ServiceManagement

enum LaunchAtLogin {
    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

    static func set(_ enabled: Bool) -> ExecutorRefusal? {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            return nil
        } catch {
            if SMAppService.mainApp.status == .requiresApproval {
                return ExecutorRefusal(
                    "Allow Nessie Executor in System Settings → General → Login Items & Extensions."
                )
            }
            return ExecutorRefusal("macOS could not change this setting. Check Login Items in System Settings.")
        }
    }
}
