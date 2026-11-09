import Foundation
import ServiceManagement

/// What the update helper needs from the owner, when anything does.
public enum ComputerUpdateAttention: Equatable, Sendable {
    /// Approved and installed, but it stopped answering: Restart updates.
    case stuck
    /// macOS won't run it until the owner allows it in Login Items.
    case needsApproval
}

/// When the approved update helper counts as stuck, and when this app restarts it.
///
/// launchd keeps running the helper an older app registered until that job
/// restarts, and the helper hands over to the installed worker, which is as old
/// as the installed runtime. Replacing the app therefore never reaches the
/// helper by itself. A newer app restarts its helper once, so the helper's
/// app-bundled entry can install this app's runtime.
public enum ComputerUpdateRecovery {
    /// Consecutive failed status probes before a slow helper counts as stuck.
    /// The update monitor asks every fifteen seconds.
    public static let unreachableProbes = 2

    /// `registration` is SMAppService's status for the helper, `nil` where this
    /// app manages none. Approval comes first: a helper waiting for it never
    /// runs, and restarting it cannot help. After this app re-registered it,
    /// macOS can also keep it from running while still reporting it enabled;
    /// Login Items is where the owner starts it again then, too.
    public static func attention(
        registration: SMAppService.Status?, factoryReady: Bool, failures: Int, reregistered: Bool
    ) -> ComputerUpdateAttention? {
        guard let registration else { return nil }
        if registration == .requiresApproval { return .needsApproval }
        guard registration == .enabled, failures >= unreachableProbes else { return nil }
        if reregistered { return .needsApproval }
        // Before the factory exists the helper is still setting up, which has its own message.
        return factoryReady ? .stuck : nil
    }

    /// At most once per app version: a restart that does not help is not
    /// repeated in a loop. The person's own Restart updates is never limited.
    /// `answer` is what the helper last said: its installed runtime and phase.
    public static func shouldRestart(
        enabled: Bool, failures: Int, answer: (installedVersion: String, phase: String)?,
        applicationVersion: String?, restartedFor: String?
    ) -> Bool {
        guard enabled, let applicationVersion, restartedFor != applicationVersion else { return false }
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
