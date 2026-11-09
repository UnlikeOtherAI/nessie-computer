import Foundation
import OSLog
import ServiceManagement

/// Apple owns approval; the registered native helper owns the installed factory.
enum ComputerUpdateService {
    private static let plist = "com.unlikeotherai.nessie.executor.updater.plist"
    private static let restarted = "computer-update-helper-restarted-for"
    private static let registrationKey = "computer-update-helper-registration"
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

    /// The helper's registration, `nil` where this app manages none.
    static var registration: SMAppService.Status? { supported ? SMAppService.daemon(plistName: plist).status : nil }

    /// Only the owner can let macOS run the helper, in Login Items.
    static func openLoginItems() { SMAppService.openSystemSettingsLoginItems() }

    /// Approved and past first setup. Before the factory exists, the helper is
    /// still setting up, which has its own message; that is never "stuck".
    static var installed: Bool { enabled && factoryReady }

    /// The runtime version this app carries, to compare with the installed one.
    static let applicationVersion: String? =
        (try? PackagedRuntime.locate(in: Bundle.main.resourceURL).get())?.executorVersion()

    /// The version whose automatic restart already happened, so it is not repeated.
    static var restartedVersion: String? { UserDefaults.standard.string(forKey: restarted) }

    /// This app version's own registrations, and why macOS last refused one.
    static var registrationRecord: ComputerUpdateRegistrationRecord {
        ComputerUpdateRegistrationRecord(
            stored: UserDefaults.standard.dictionary(forKey: registrationKey), version: applicationVersion ?? ""
        )
    }

    /// Why macOS refused this app's last `register()`, while that still holds.
    static var registrationFailure: String? { supported ? registrationRecord.failure : nil }

    /// Registers when macOS has no registration: first setup, a restart whose
    /// `register()` was refused, or the owner's Try again (`requested`). The app
    /// makes `ComputerUpdateRegistration.automaticAttempts` attempts by itself
    /// for each version, never a loop; the owner's request is never limited.
    /// A refusal is kept for the window and the menu, and logged.
    @MainActor
    static func prepare(requested: Bool = false) {
        guard supported else { return }
        let service = SMAppService.daemon(plistName: plist)
        if ComputerUpdateRegistration.shouldRegister(
            status: service.status, requested: requested, attempts: registrationRecord.attempts
        ) {
            register(service, automatic: !requested)
            logger.info("Background helper status: \(service.status.rawValue)")
        }
        // Approval given or withdrawn in System Settings changes what the menu says, too.
        ComputerUpdateHealth.shared.registrationChanged()
        if requested && service.status != .enabled { SMAppService.openSystemSettingsLoginItems() }
    }

    /// launchd keeps the job an older app registered until that job restarts,
    /// so a newer app's helper never runs by itself. Removing and adding the
    /// registration starts this app's bundled helper. A requested restart that
    /// ends awaiting approval opens the place to give it. When macOS refuses
    /// the new registration, launchd runs no helper; the refusal is kept, and
    /// `prepare` registers again.
    @MainActor
    static func restart(requested: Bool) async {
        guard supported else { return }
        let service = SMAppService.daemon(plistName: plist)
        if service.status == .enabled {
            do { try await service.unregister() } catch {
                let message = String(describing: error)
                logger.error("Background helper restart failed to unregister: \(message, privacy: .public)")
                return
            }
        }
        register(service, automatic: !requested)
        logger.info("Background helper restarted, status: \(service.status.rawValue)")
        if requested && service.status != .enabled { SMAppService.openSystemSettingsLoginItems() }
    }

    /// The automatic restart: at most once for each app version.
    @MainActor
    static func restartOnce(for version: String) async {
        UserDefaults.standard.set(version, forKey: restarted)
        await restart(requested: false)
    }

    /// One `register()`. macOS may report launch denial after registering a
    /// daemon that still awaits approval; its status is the recovery door then.
    /// Any other refusal is never swallowed: it is logged and kept.
    @MainActor
    private static func register(_ service: SMAppService, automatic: Bool) {
        var record = registrationRecord
        if automatic { record.attempts += 1 }
        var refusal: Error?
        do { try service.register() } catch { refusal = error }
        record.failure = ComputerUpdateRegistration.failure(
            after: refusal, status: service.status, fallback: Word.updatesRegistrationRefused.text
        )
        if let failure = record.failure {
            let detail = refusal.map { String(describing: $0) } ?? failure
            logger.error("Background helper registration failed: \(detail, privacy: .public)")
        }
        UserDefaults.standard.set(record.stored, forKey: registrationKey)
        ComputerUpdateHealth.shared.registrationChanged()
    }

    /// Shown while the helper can't be reached or refuses. Display only, like
    /// the setup states below; it never reaches a heartbeat or an install.
    static func stuckStatus() -> [String: Any] { localStatus(phase: "failed", code: "update.helper_unavailable") }

    /// Shown while macOS waits for the owner to allow the helper. Display only.
    static func approvalStatus() -> [String: Any] { localStatus(phase: "failed", code: "update.approval_required") }

    /// Shown while macOS refuses to register the helper, with its reason. Display only.
    static func registrationFailedStatus(_ reason: String) -> [String: Any] {
        var status = localStatus(phase: "failed", code: "update.registration_failed")
        status["reason"] = reason
        return status
    }

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
