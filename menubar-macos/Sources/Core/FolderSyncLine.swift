import Foundation

/// `describe --json`'s `folderSync`: the fields of the console's
/// `FolderSyncConsoleState` the menu's Sync line needs. The Windows tray reads
/// the same fields from `sync status --json`, so both apps derive their line
/// from the same facts.
public struct FolderSyncSummary: Equatable, Decodable, Sendable {
    public struct Counts: Equatable, Decodable, Sendable {
        public let pendingUploads: Int
        public let pendingDownloads: Int
        public let openConflicts: Int
        public let waiting: Int
        public let errors: Int
        public let heldDeletes: Int
    }

    public let enabled: Bool
    public let state: String
    public let counts: Counts
}

/// What the Sync line says about one team.
public enum FolderSyncLine: Equatable, Sendable {
    case off
    case notPrivate
    case paused
    case upToDate
    case starting
    case offline
    case syncing(Int)
    case conflicts(Int)
    case needsAttention
    case allowInNessie
    case allowAgainInNessie
    case folderMissing
    case diskFull

    private static let fixed: [String: FolderSyncLine] = [
        "off": .off, "paused": .paused, "starting": .starting, "offline": .offline,
        "waiting_for_confirmation": .allowInNessie, "needs_reauthorization": .allowAgainInNessie,
        "root_missing": .folderMissing, "disk_full": .diskFull
    ]

    /// The console's honest rule (`syncStatusKey` in `sync.js`): never Up to
    /// date while anything is pending, waiting or in conflict. Open conflicts
    /// are named by count, because that is what the person is coming to
    /// resolve. A state this build does not know gives no line, not a guess.
    public init?(_ summary: FolderSyncSummary) {
        let counts = summary.counts
        if summary.state == "not_private" {
            self = .notPrivate
            return
        }
        guard summary.enabled else {
            self = .off
            return
        }
        if let line = Self.fixed[summary.state] {
            self = line
            return
        }
        guard ["up_to_date", "syncing", "needs_attention"].contains(summary.state) else { return nil }
        let pending = counts.pendingUploads + counts.pendingDownloads
        let asks = counts.heldDeletes + counts.errors > 0 || summary.state == "needs_attention"
        if counts.openConflicts > 0 {
            self = .conflicts(counts.openConflicts)
        } else if asks && pending == 0 {
            self = .needsAttention
        } else if summary.state == "up_to_date" && !asks && pending + counts.waiting == 0 {
            self = .upToDate
        } else {
            self = .syncing(pending)
        }
    }

    /// Something only the person can settle: the menu bar icon turns amber.
    public var needsYou: Bool {
        switch self {
        case .conflicts, .needsAttention, .allowInNessie, .allowAgainInNessie, .folderMissing, .diskFull:
            return true
        default:
            return false
        }
    }

    var rank: Int {
        if needsYou { return 5 }
        switch self {
        case .syncing, .starting, .offline: return 4
        case .upToDate: return 3
        case .paused: return 2
        case .notPrivate: return 1
        default: return 0
        }
    }

    public var label: String { "Sync: \(text)" }

    private var text: String {
        switch self {
        case .off: return "off"
        case .notPrivate: return "not on a shared computer"
        case .paused: return "paused"
        case .upToDate: return "up to date"
        case .starting: return "starting"
        case .offline: return "offline"
        case .syncing(0): return "syncing"
        case let .syncing(count): return "syncing \(count) \(count == 1 ? "file" : "files")"
        case let .conflicts(count): return "\(count) \(count == 1 ? "conflict" : "conflicts")"
        case .needsAttention: return "needs your attention"
        case .allowInNessie: return "allow it in Nessie"
        case .allowAgainInNessie: return "allow it again in Nessie"
        case .folderMissing: return "folder missing"
        case .diskFull: return "disk full"
        }
    }
}

/// The team the Sync line is about, and what it says.
public struct FolderSyncOverview: Equatable, Sendable {
    public let executorId: String
    public let line: FolderSyncLine

    public init(executorId: String, line: FolderSyncLine) {
        self.executorId = executorId
        self.line = line
    }

    /// The team that most needs the person; the first listed wins a tie.
    public static func mostDemanding(_ teams: [(executorId: String, summary: FolderSyncSummary?)]) -> Self? {
        var best: Self?
        for team in teams {
            guard let summary = team.summary, let line = FolderSyncLine(summary) else { continue }
            if let current = best, current.line.rank >= line.rank { continue }
            best = Self(executorId: team.executorId, line: line)
        }
        return best
    }
}

/// The menu line: the status when one is known, otherwise a plain doorway.
public func folderSyncMenuTitle(_ overview: FolderSyncOverview?) -> String {
    overview?.line.label ?? "Sync…"
}

/// The icon's tooltip names sync only when it needs the person.
public func menuToolTip(header: String, sync overview: FolderSyncOverview?) -> String {
    guard let overview, overview.line.needsYou else { return header }
    return "\(header)\n\(overview.line.label)"
}
