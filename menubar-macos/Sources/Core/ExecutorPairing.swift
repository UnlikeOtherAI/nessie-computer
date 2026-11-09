import Foundation

/// The shared runtime's JSON pairing boundary. A connected team's names are its
/// saved display-only label (`docs/team-names.md`), never another identity store.
public struct ExecutorPairing: Decodable, Equatable, Sendable {
    public enum Status: String, Decodable, Sendable {
        case waiting, paired, alreadyPaired, expired, cancelled, idle
    }

    public let status: Status
    public let code: String?
    public let expiresAt: String?
    public let machineName: String?
    public let organizationName: String?
    public let teamName: String?
    public let fingerprint: String?
    public let apiBaseUrl: String?

    public static var genericFailureMessage: String { Word.pairingFailed.text }

    /// Interpret only the shared runtime's known structural error code. Raw
    /// output and unknown messages never become pairing-screen copy.
    public static func failureMessage(from data: Data) -> String {
        let failure = try? JSONDecoder().decode([String: [String: String]].self, from: data)
        guard failure?["error"]?["code"] == "workspace_cleanup_required" else { return genericFailureMessage }
        return Word.pairingCleanupRequired.text
    }

    public static func decode(_ data: Data) throws -> ExecutorPairing {
        let pairing = try JSONDecoder().decode(ExecutorPairing.self, from: data)
        if pairing.status == .waiting {
            // The fingerprint is no longer shown, so it is not required: Nessie
            // asks the person to confirm this computer by its name instead.
            guard let code = pairing.code, code.utf8.count == 8,
                  code.utf8.allSatisfy({ (48...57).contains($0) }), pairing.expiration != nil else {
                throw ExecutorRefusal(.pairingCodeMissing)
            }
        }
        return pairing
    }

    public var expiration: Date? {
        guard let expiresAt else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: expiresAt) ?? ISO8601DateFormatter().date(from: expiresAt)
    }

    /// A claim in Nessie completes the pairing, so the only open step is the code.
    public var isPending: Bool { status == .waiting }
    /// An expired attempt still owns pending machine material until the runtime
    /// cancels it. Keep its cancel control reachable before offering a new code.
    public var isAttemptOpen: Bool { isPending || status == .expired }
    public var isPaired: Bool { status == .paired || status == .alreadyPaired }
}
