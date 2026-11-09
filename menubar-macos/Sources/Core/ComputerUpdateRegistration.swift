import Foundation
import ServiceManagement

/// What this app's own `register()` calls did for one app version: how many of
/// its automatic ones macOS refused since it last accepted one, and why macOS
/// last refused, in macOS's own words.
public struct ComputerUpdateRegistrationRecord: Equatable, Sendable {
    public let version: String
    public var attempts: Int
    public var failure: String?

    public init(version: String, attempts: Int = 0, failure: String? = nil) {
        self.version = version
        self.attempts = attempts
        self.failure = failure
    }

    /// The saved record when it belongs to `version`; a new app version starts afresh.
    public init(stored: [String: Any]?, version: String) {
        guard let stored, stored["version"] as? String == version else {
            self.init(version: version)
            return
        }
        self.init(version: version, attempts: stored["attempts"] as? Int ?? 0, failure: stored["failure"] as? String)
    }

    public var stored: [String: Any] {
        var stored: [String: Any] = ["version": version, "attempts": attempts]
        if let failure { stored["failure"] = failure }
        return stored
    }
}

/// When this app registers its update helper with macOS, and what it keeps
/// from a refusal.
public enum ComputerUpdateRegistration {
    /// Refused registrations this app makes by itself for one app version: the
    /// first refusal (the restart's, say) and one more. After that only the
    /// owner's Try again registers, so a refusal is never retried in a loop.
    public static let automaticAttempts = 2

    /// The record after one `register()`. Only refusals count: on 9 November
    /// (1.0.19) the launch's accepted registration used the first attempt, the
    /// restart's refusal the second, and the app never registered again.
    public static func recorded(
        _ record: ComputerUpdateRegistrationRecord, automatic: Bool, failure: String?
    ) -> ComputerUpdateRegistrationRecord {
        var next = record
        next.failure = failure
        if failure == nil {
            next.attempts = 0
        } else if automatic {
            next.attempts += 1
        }
        return next
    }

    /// Waits until macOS no longer reports the helper registered after
    /// `unregister()` returned. Login Items keeps the removed job enabled for
    /// a moment; a `register()` in that moment is refused with "Operation not
    /// permitted" (smd: "Job is not allowed to bootstrap"), which is what left
    /// 1.0.19 with no helper. `false` when it never settled within `polls`.
    public static func settle(
        polls: Int = 40, status: () -> SMAppService.Status, pause: () async -> Void
    ) async -> Bool {
        for poll in 0...polls {
            if status() != .enabled { return true }
            if poll < polls { await pause() }
        }
        return false
    }

    /// A missing BTM record (`notFound`) is a first-registration state, not a
    /// missing certificate. `notRegistered` also follows a restart whose
    /// `register()` macOS refused: launchd then runs no helper at all.
    public static func shouldRegister(status: SMAppService.Status, requested: Bool, attempts: Int) -> Bool {
        (status == .notRegistered || status == .notFound) && (requested || attempts < automaticAttempts)
    }

    /// Kept after one `register()`. Approval and success clear an old refusal; a
    /// call that returns while macOS still has no registration is a refusal too.
    public static func failure(
        after error: Error?, status: SMAppService.Status, fallback: String
    ) -> String? {
        if status == .enabled || status == .requiresApproval { return nil }
        guard let error else { return fallback }
        return reason(error, fallback: fallback)
    }

    /// The short reason macOS gave, such as "Operation not permitted". Error
    /// codes stay in the unified log; a description that is only a code is
    /// replaced with `fallback`.
    public static func reason(_ error: Error, fallback: String) -> String {
        let error = error as NSError
        let candidates = [error.localizedFailureReason, error.localizedDescription]
        for candidate in candidates {
            guard let text = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty,
                  !text.contains(error.domain) else { continue }
            return text.count > 120 ? String(text.prefix(119)) + "…" : text
        }
        return fallback
    }
}
