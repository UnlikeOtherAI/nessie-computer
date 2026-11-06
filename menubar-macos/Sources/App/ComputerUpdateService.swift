import Foundation
import OSLog
import ServiceManagement

/// Apple owns approval; the registered native helper owns the installed factory.
enum ComputerUpdateService {
    private static let plist = "com.unlikeotherai.nessie.executor.updater.plist"
    private static let attempted = "computer-update-helper-registration-attempted"
    private static let logger = Logger(subsystem: "com.unlikeotherai.nessie.executor.menubar", category: "updates")
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
        if ComputerUpdateRegistration.shouldRegister(
            status: service.status, attempted: UserDefaults.standard.bool(forKey: attempted), requested: requested
        ) {
            do { try service.register() } catch {
                // macOS may report launch denial after registering a daemon
                // that still awaits approval. Its status is the recovery door.
                if service.status != .requiresApproval {
                    let message = String(describing: error)
                    logger.error("Background helper registration failed: \(message, privacy: .public)")
                    throw error
                }
            }
            UserDefaults.standard.set(true, forKey: attempted)
        }
        logger.info("Background helper status: \(service.status.rawValue)")
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
