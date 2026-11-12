import ServiceManagement

enum LaunchAtLogin {
    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

    static func set(_ enabled: Bool) -> ExecutorRefusal? {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            return nil
        } catch {
            if SMAppService.mainApp.status == .requiresApproval {
                return ExecutorRefusal(.loginItemNeedsApproval)
            }
            return ExecutorRefusal(.loginItemFailed)
        }
    }
}
