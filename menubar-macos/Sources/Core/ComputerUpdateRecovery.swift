import Foundation
import ServiceManagement

/// What the update helper needs from the owner, when anything does.
public enum ComputerUpdateAttention: Equatable, Sendable {
    /// Approved and installed, but it stopped answering: Restart updates.
    case stuck
    /// macOS won't run it until the owner allows it in Login Items.
    case needsApproval
    /// macOS refused to register it, so launchd runs no helper: Try again.
    /// `reason` is macOS's own short reason.
    case registrationFailed(reason: String)
}

/// The automatic helper restarts this app made for one app version, and when
/// it made the last one.
public struct ComputerUpdateRestartRecord: Equatable, Sendable {
    public let version: String
    public var made: Int
    public var last: Date?

    public init(version: String, made: Int = 0, last: Date? = nil) {
        self.version = version
        self.made = made
        self.last = last
    }

    /// The saved record when it belongs to `version`; a new app version starts afresh.
    public init(stored: [String: Any]?, version: String) {
        guard let stored, stored["version"] as? String == version else {
            self.init(version: version)
            return
        }
        self.init(version: version, made: stored["made"] as? Int ?? 0,
                  last: (stored["last"] as? Double).map(Date.init(timeIntervalSince1970:)))
    }

    public var stored: [String: Any] {
        var stored: [String: Any] = ["version": version, "made": made]
        if let last { stored["last"] = last.timeIntervalSince1970 }
        return stored
    }

    /// The record after one more automatic restart at `now`.
    public func restarted(at now: Date) -> ComputerUpdateRestartRecord {
        ComputerUpdateRestartRecord(version: version, made: made + 1, last: now)
    }
}

/// When the approved update helper counts as stuck, and when this app restarts it.
///
/// launchd keeps running the helper an older app registered until that job
/// restarts, and the helper hands over to the installed worker, which is as old
/// as the installed runtime. Replacing the app therefore never reaches the
/// helper by itself. A newer app restarts its helper, so the helper's
/// app-bundled entry can install this app's runtime, and restarts it again,
/// later each time, for as long as the helper stays stuck or older: a swap
/// that had to wait (Nessie Desktop open, say) gets another chance without a
/// click.
public enum ComputerUpdateRecovery {
    /// Consecutive failed status probes before a slow helper counts as stuck.
    /// The update monitor asks every fifteen seconds.
    public static let unreachableProbes = 2

    /// `registration` is SMAppService's status for the helper, `nil` where this
    /// app manages none. Approval comes first: a helper waiting for it never
    /// runs, and restarting it cannot help. After this app re-registered it,
    /// macOS can also keep it from running while still reporting it enabled;
    /// Login Items is where the owner starts it again then, too.
    /// `registrationFailure` is why macOS last refused this app's `register()`;
    /// it counts only while the helper is still not registered.
    public static func attention(
        registration: SMAppService.Status?, factoryReady: Bool, failures: Int, reregistered: Bool,
        registrationFailure: String?
    ) -> ComputerUpdateAttention? {
        guard let registration else { return nil }
        if registration == .requiresApproval { return .needsApproval }
        if registration == .notRegistered || registration == .notFound {
            // Not yet attempted, or attempts still to come: setup has its own state.
            return registrationFailure.map { .registrationFailed(reason: $0) }
        }
        guard registration == .enabled, failures >= unreachableProbes else { return nil }
        if reregistered { return .needsApproval }
        // Before the factory exists the helper is still setting up, which has its own message.
        return factoryReady ? .stuck : nil
    }

    /// How long after `made` automatic restarts for this version the next one
    /// may come: 15 minutes, doubling, at most 4 hours.
    public static func restartDelay(after made: Int) -> TimeInterval {
        guard made > 0 else { return 0 }
        return min(900 * pow(2, Double(min(made, 6) - 1)), 14_400)
    }

    /// Whether the helper needs restarting now. `restarts` belongs to this
    /// app's version, `nil` where the version is unknown. The first restart
    /// for a version comes at once; each further one waits out `restartDelay`,
    /// so a restart that did not help is retried, never in a tight loop. The
    /// person's own Restart updates is never limited. `answer` is what the
    /// helper last said: its installed runtime and phase.
    public static func shouldRestart(
        enabled: Bool, failures: Int, answer: (installedVersion: String, phase: String)?,
        restarts: ComputerUpdateRestartRecord?, now: Date
    ) -> Bool {
        guard enabled, let restarts, needsRestart(failures: failures, answer: answer,
                                                  applicationVersion: restarts.version) else {
            return false
        }
        return restartDue(restarts, now: now)
    }

    /// The first automatic restart for a version is due at once; each further
    /// one after `restartDelay`.
    public static func restartDue(_ restarts: ComputerUpdateRestartRecord, now: Date) -> Bool {
        guard restarts.made > 0, let last = restarts.last else { return true }
        return now.timeIntervalSince(last) >= restartDelay(after: restarts.made)
    }

    /// Whether a helper restart can bring this app's newer runtime. The helper
    /// installs it only while no team process runs, so the teams stop for that
    /// moment. `installedVersion` is read from the installed runtime itself, so
    /// this holds even while the helper does not answer; `phase` is what it last
    /// said, if anything, and a started replacement is never interrupted.
    public static func adoptsApplicationRuntime(
        installedVersion: String?, phase: String?, applicationVersion: String
    ) -> Bool {
        guard let installedVersion, !["installing", "restarting"].contains(phase ?? "") else { return false }
        return isNewer(applicationVersion, than: installedVersion)
    }

    private static func needsRestart(
        failures: Int, answer: (installedVersion: String, phase: String)?, applicationVersion: String
    ) -> Bool {
        if failures >= unreachableProbes { return true }
        // A started replacement belongs to the helper; never interrupt it.
        guard let answer, !["installing", "restarting"].contains(answer.phase) else { return false }
        return isNewer(applicationVersion, than: answer.installedVersion)
    }

    /// Numeric `major.minor.patch` only; anything else is never newer.
    public static func isNewer(_ left: String, than right: String) -> Bool {
        guard let left = parts(left), let right = parts(right) else { return false }
        return right.lexicographicallyPrecedes(left)
    }

    private static func parts(_ version: String) -> [UInt64]? {
        let parts = version.split(separator: ".", omittingEmptySubsequences: false).map { UInt64($0) }
        guard parts.count == 3, parts.allSatisfy({ $0 != nil }) else { return nil }
        return parts.compactMap { $0 }
    }
}
