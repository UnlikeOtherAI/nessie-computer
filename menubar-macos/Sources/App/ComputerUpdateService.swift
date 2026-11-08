import Foundation
import OSLog
import ServiceManagement

/// Apple owns approval; the registered native helper owns the installed factory.
enum ComputerUpdateService {
    private static let plist = "com.unlikeotherai.nessie.executor.updater.plist"
    private static let attempted = "computer-update-helper-registration-attempted"
    private static let restarted = "computer-update-helper-restarted-for"
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

    static var enabled: Bool { supported && SMAppService.daemon(plistName: plist).status == .enabled }

    /// Approved and past first setup. Before the factory exists, the helper is
    /// still setting up, which has its own message; that is never "stuck".
    static var installed: Bool { enabled && factoryReady }

    /// The runtime version this app carries, to compare with the installed one.
    static var applicationVersion: String? {
        (try? PackagedRuntime.locate(in: Bundle.main.resourceURL).get())?.executorVersion()
    }

    /// The version whose automatic restart already happened, so it is not repeated.
    static var restartedVersion: String? { UserDefaults.standard.string(forKey: restarted) }

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

    /// launchd keeps the job an older app registered until that job restarts,
    /// so a newer app's helper never runs by itself. Removing and adding the
    /// registration starts this app's bundled helper. A requested restart that
    /// ends awaiting approval opens the place to give it.
    @MainActor
    static func restart(requested: Bool) async throws {
        guard supported else { return }
        let service = SMAppService.daemon(plistName: plist)
        if service.status == .enabled { try await service.unregister() }
        do { try service.register() } catch {
            if service.status != .requiresApproval {
                let message = String(describing: error)
                logger.error("Background helper restart failed: \(message, privacy: .public)")
                throw error
            }
        }
        UserDefaults.standard.set(true, forKey: attempted)
        logger.info("Background helper restarted, status: \(service.status.rawValue)")
        if requested && service.status != .enabled { SMAppService.openSystemSettingsLoginItems() }
    }

    /// The automatic restart: at most once for each app version.
    @MainActor
    static func restartOnce(for version: String) async {
        UserDefaults.standard.set(version, forKey: restarted)
        try? await restart(requested: false)
    }

    /// Shown while the helper can't be reached or refuses. Display only, like
    /// the setup states below; it never reaches a heartbeat or an install.
    static func stuckStatus() -> [String: Any] { localStatus(phase: "failed", code: "update.helper_unavailable") }

    /// Shown right after a restart, before the helper answers again.
    static func restartingStatus() -> [String: Any] { localStatus(phase: "checking", code: nil) }

    private static func localStatus(phase: String, code: String?) -> [String: Any] {
        var status: [String: Any] = ["format": 1, "installedVersion": "", "sourceCommit": "", "automatic": true,
                                     "channel": "stable", "canInstall": false, "draining": false, "notify": false,
                                     "phase": phase]
        if let code { status["code"] = code }
        return status
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
