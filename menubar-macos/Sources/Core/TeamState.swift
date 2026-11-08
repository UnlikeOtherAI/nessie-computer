import Foundation

/// Whether a team's daemon process is alive. `stopping` is a lease in the
/// state directory held by a process that is still alive — a prior daemon
/// tearing down — the same fact `daemon_status` reads in the Tauri companion.
public enum DaemonState: String, Equatable, Sendable {
    case stopped
    case running
    case stopping
}

/// One team directory's latest reading, replaced wholesale on every refresh.
///
/// A team this Mac cannot describe is a *state* here rather than an absence:
/// an icon that silently kept its last pixel while the runtime refused to
/// start would be the worst outcome available.
public struct ConnectionModel: Equatable, Sendable {
    public enum Pairing: Equatable, Sendable {
        /// The packaged runtime is missing, or `describe` refused. The reason is
        /// the CLI's own, never a substitute.
        case unavailable(String)
        case unpaired
        case paired(ExecutorDescription)
    }

    public var pairing: Pairing
    public var daemon: DaemonState

    public init(pairing: Pairing, daemon: DaemonState) {
        self.pairing = pairing
        self.daemon = daemon
    }

    public var description: ExecutorDescription? {
        if case let .paired(description) = pairing { return description }
        return nil
    }
}

/// The failure that last stopped a team, exactly as it arrived. The console
/// translates it; `code` is set only when `FailureClassifier` recognises it.
public struct TeamFailure: Equatable, Sendable {
    public let code: String?
    public let message: String

    public init(code: String?, message: String) {
        self.code = code
        self.message = message
    }

    public init(classifying message: String) {
        self.init(code: FailureClassifier.code(for: message), message: message)
    }
}

/// What one paired team is doing, in the words the menu uses.
public enum TeamActivity: Equatable, Sendable {
    case working
    case paused
    case connecting
    case notConnected
}

/// Everything the menu needs to know about one paired team.
public struct TeamSnapshot: Equatable, Sendable {
    public let executorId: String
    public let label: String
    public let daemon: DaemonState
    /// A start is under way.
    public let connecting: Bool
    /// The owner paused this team; the daemon keeps running and refuses work.
    public let paused: Bool
    public let failure: TeamFailure?
    /// An automatic restart is scheduled, so a failure is not yet the owner's.
    public let retrying: Bool
    public let pendingProgramRequests: Int
    public let documents: FolderSyncLine?

    public init(
        executorId: String,
        label: String,
        daemon: DaemonState,
        connecting: Bool = false,
        paused: Bool = false,
        failure: TeamFailure? = nil,
        retrying: Bool = false,
        pendingProgramRequests: Int = 0,
        documents: FolderSyncLine? = nil
    ) {
        self.executorId = executorId
        self.label = label
        self.daemon = daemon
        self.connecting = connecting
        self.paused = paused
        self.failure = failure
        self.retrying = retrying
        self.pendingProgramRequests = pendingProgramRequests
        self.documents = documents
    }

    /// Paused outranks the process: a paused team is not stopped, and a
    /// paused team whose daemon is restarting is still paused.
    public var activity: TeamActivity {
        if paused { return .paused }
        if daemon == .running { return .working }
        return connecting ? .connecting : .notConnected
    }

    /// The one thing about this team that only its owner can settle, if any.
    /// Starting, stopping and connecting never need the owner, and neither
    /// does a failure an automatic restart is about to retry.
    public var needsYou: NeedsYouReason? {
        if pendingProgramRequests > 0 { return .programs(pendingProgramRequests) }
        if failure != nil, !retrying, daemon != .running, !connecting { return .notConnected }
        return documents.flatMap(\.needsYouReason)
    }
}
