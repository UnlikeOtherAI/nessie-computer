import Foundation
import ServiceManagement

/// Apple owns approval; the registered native helper owns the installed factory.
enum ComputerUpdateService {
    private static let plist = "com.unlikeotherai.nessie.executor.updater.plist"
    private static let attempted = "computer-update-helper-registration-attempted"
    static let factory = URL(fileURLWithPath:
        "/Library/Application Support/Nessie Executor/current/nessie-executor-native")

    private static var supported: Bool {
        !AppBuild.isDevelopment && [
            "/Applications/Nessie Executor.app",
            "/Applications/Nessie.app/Contents/Library/LoginItems/Nessie Executor.app",
            "/Applications/Nessie Desktop.app/Contents/Library/LoginItems/Nessie Executor.app"
        ].contains(Bundle.main.bundlePath)
    }

    static var factoryReady: Bool { FileManager.default.fileExists(atPath: factory.path) }

    /// Register once automatically. An explicitly removed helper is restored
    /// only by the person's Settings action, never on every subsequent launch.
    @MainActor
    static func prepare(requested: Bool = false) throws {
        guard supported else { return }
        let service = SMAppService.daemon(plistName: plist)
        if service.status == .notRegistered && (requested || !UserDefaults.standard.bool(forKey: attempted)) {
            try service.register()
            UserDefaults.standard.set(true, forKey: attempted)
        }
        if requested && service.status != .enabled { SMAppService.openSystemSettingsLoginItems() }
    }

    /// Local setup information is never used for heartbeats or update acceptance.
    /// In particular, the bundled version cannot stand in for an installed one.
    static func unavailableStatus() -> [String: Any]? {
        guard supported else { return nil }
        let enabled = SMAppService.daemon(plistName: plist).status == .enabled
        guard !enabled || !factoryReady else { return nil }
        return ["format": 1, "installedVersion": "", "sourceCommit": "", "automatic": true,
                "channel": "stable", "canInstall": false, "draining": false, "notify": false,
                "phase": "unsupported", "code": enabled ? "update.bootstrap_required" : "update.setup_required"]
    }
}
