import Foundation

/// The JSON `nessie-computer describe` prints, and the only shape this app
/// renders. `executor/src/describe.ts` is its producer; nothing here reads
/// `executor-state.json`, so the app can never hold a second interpretation of
/// a local policy the daemon enforces.
public struct ExecutorDescription: Equatable, Decodable, Sendable {
    public struct Limits: Equatable, Decodable, Sendable {
        public let maxCommandRuntimeSeconds: Int
        public let maxResultBytes: Int
        public let maxSessions: Int
    }

    public struct Policy: Equatable, Decodable, Sendable {
        public let limits: Limits
        public let operations: [String]
        /// Empty means no command may start, not "no restriction".
        public let permittedPrograms: [String]
        public let profiles: [String]
        public let revision: Int
        /// The folder names the last proposed revision names. Empty means the
        /// descriptor predates named folders.
        public let workspaceFolders: [String]
    }

    /// One read-only host folder, under the name that starts every workspace
    /// path an agent writes: `file.read nessie/api/src/index.ts` reads inside
    /// the folder named `nessie`.
    public struct Folder: Equatable, Decodable, Sendable, Identifiable {
        public let name: String
        public let path: String
        public var id: String { name }
    }

    /// Whether a guest VM session can start at all. A guest mounts one
    /// workspace, so `command.run` and `coding.launch` refuse outright while
    /// more than one folder is configured.
    public enum GuestSessions: String, Equatable, Decodable, Sendable {
        case available
        case refusedMultipleFolders = "refused_multiple_folders"
    }

    public struct Reach: Equatable, Decodable, Sendable {
        /// HTTPS origins the guest browser may open; empty until one is configured.
        public let allowedOrigins: [String]
        public let folders: [Folder]
        public let guestSessions: GuestSessions
    }

    public struct Sandbox: Equatable, Decodable, Sendable {
        public let browserConfigured: Bool
        public let codingConfigured: Bool
        public let promotionHelperConfigured: Bool
    }

    public let apiBaseUrl: String
    public let executorId: String
    public let policy: Policy
    public let reach: Reach
    public let sandbox: Sandbox
    /// Folder sync on this connection; absent from a runtime that predates it.
    public let folderSync: FolderSyncSummary?
    /// The owner paused this team on this computer. Absent from a runtime that
    /// predates Pause, which could not have been paused.
    public let paused: Bool?
    /// Program requests waiting for the owner's answer; absent from a runtime
    /// that predates them.
    public let pendingProgramRequests: Int?

    public static func decode(_ data: Data) throws -> ExecutorDescription {
        try JSONDecoder().decode(ExecutorDescription.self, from: data)
    }

    public var commandRunEnabled: Bool { policy.operations.contains(ExecutorPolicy.commandOperationKey) }
    public var isPaused: Bool { paused ?? false }
}

public enum ExecutorPolicy {
    public static let commandOperationKey = "command.run"
}
