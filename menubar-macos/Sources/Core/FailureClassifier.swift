import Foundation

/// Recognises the refusals this app has to act on, by the code they stand for.
///
/// The CLI writes `error.message` to standard error and nothing else, so the
/// code never reaches this process. The messages are fixed literals beside
/// their codes in `executor-manage`; each line below names the code it stands
/// for, so a message that changes falls through to "unrecognised" rather than
/// being mislabelled. What a failure *means* to a person is the console's job
/// (its one translator is keyed by these codes); this file only identifies.
public enum FailureClassifier {
    private static let known: [(message: String, code: String)] = [
        ("Executor descriptor revisions cannot move backwards.", "EXECUTOR_DESCRIPTOR_ROLLBACK"),
        ("A descriptor revision cannot describe two different policies.", "EXECUTOR_DESCRIPTOR_REVISION_CONFLICT"),
        ("Executor connection is fenced.", "EXECUTOR_CONNECTION_FENCED"),
        ("Executor descriptor proof is invalid.", "EXECUTOR_DAEMON_PROOF_INVALID"),
        ("Executor proof is invalid.", "EXECUTOR_DAEMON_PROOF_INVALID"),
        ("Executor heartbeat is stale.", "EXECUTOR_HEARTBEAT_STALE"),
        ("Executor control call is stale.", "EXECUTOR_HEARTBEAT_STALE"),
        ("The confirmation fingerprint does not match the pending executor.", "FINGERPRINT_NOT_CONFIRMED"),
        ("No active executor enrollment is ready to confirm.", "FINGERPRINT_NOT_CONFIRMED"),
        ("No active executor enrollment is ready", "ENROLLMENT_EXPIRED"),
        ("Executor API request timed out.", "EXECUTOR_API_TIMEOUT")
    ]

    /// The code a refusal stands for, or `nil` when this build does not know it.
    public static func code(for message: String) -> String? {
        let detail = message.trimmingCharacters(in: .whitespacesAndNewlines)
        return known.first { detail.contains($0.message) }?.code
    }

    /// Nessie refused a revision as older than, or different from, one it has
    /// already recorded: proposing the same settings again as a newer revision
    /// is the fix.
    public static func isStaleRevision(_ message: String) -> Bool {
        ["EXECUTOR_DESCRIPTOR_ROLLBACK", "EXECUTOR_DESCRIPTOR_REVISION_CONFLICT"].contains(code(for: message))
    }

    /// Whether starting again later could succeed on its own. A refusal that
    /// names a cause only a person can settle is never retried: retrying a
    /// fenced connection would take it back from the other computer every few
    /// minutes, and a rejected key or revision stays rejected. A timeout, a
    /// stale heartbeat and anything unrecognised (a network that is not up
    /// yet at login looks like that) are tried again.
    public static func isRetryable(_ message: String) -> Bool {
        guard let code = code(for: message) else { return true }
        return ["EXECUTOR_API_TIMEOUT", "EXECUTOR_HEARTBEAT_STALE"].contains(code)
    }
}

/// A fix the console may ask for beside a failure. The console decides which
/// one a failure offers; performing it stays native.
public enum NativeRemedy: String, CaseIterable, Sendable {
    /// Propose the settings this Mac already has as a newer revision, then reconnect.
    case reProposePolicy
    /// Open the paired Nessie's Computers page.
    case openNessie
    /// Stop this team's daemon and start it again.
    case restartExecutor
}
