import Foundation

/// `describe --json`'s `folderSync`: the fields of the console's
/// `FolderSyncConsoleState` the menu needs to know whether a team's documents
/// need the owner. The Windows tray reads the same fields from
/// `sync status --json`, so both apps decide from the same facts.
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

/// The state of one team's documents copy, as the menu reads it.
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

    /// Something only the person can settle, named for the "Needs you" line.
    public var needsYouReason: NeedsYouReason? {
        switch self {
        case let .conflicts(count): return .documentConflicts(count)
        case .needsAttention: return .documentsNeedChecking
        case .allowInNessie: return .allowDocumentsInNessie
        case .allowAgainInNessie: return .allowDocumentsAgain
        case .folderMissing: return .documentsFolderMissing
        case .diskFull: return .diskFull
        default: return nil
        }
    }

    /// The menu bar icon turns amber.
    public var needsYou: Bool { needsYouReason != nil }
}
