import Foundation

/// The surfaces this app exists for, as one list.
///
/// They live in a single window behind one selector rather than in three
/// windows a person has to find separately: the first version opened a window
/// per surface from the menu, and there was no way to get from one to another —
/// a person could not tell they were three views of the same thing. The menu
/// lines still exist as doorways, and each one selects a section in that window.
public enum ConsoleSection: String, CaseIterable, Identifiable, Sendable {
    case settings
    case reach
    case tools
    /// One team's folder sync. Its menu line carries a live status instead of
    /// this title (`folderSyncMenuTitle`).
    case sync

    public var id: String { rawValue }

    /// The selector's label. Short, because a segmented control has to fit
    /// them side by side.
    public var title: String {
        switch self {
        case .settings: return "Settings"
        case .reach: return "Where it can reach"
        case .tools: return "Tools it can run"
        case .sync: return "Sync"
        }
    }

    /// The line in the status menu, which says the same thing in the same words.
    public var menuTitle: String { "\(title)…" }

    public var symbolName: String {
        switch self {
        case .settings: return "gearshape"
        case .reach: return "globe.badge.chevron.backward"
        case .tools: return "terminal"
        case .sync: return "arrow.triangle.2.circlepath"
        }
    }

    public var subtitle: String {
        switch self {
        case .settings:
            return "Pair this Mac, choose the folder it may read, and decide whether it starts at login."
        case .reach:
            return "Everything outside this list is outside the executor's reach."
        case .tools:
            return "The commands the guest may start. "
                + "Anything that does not match this list is refused before a guest starts."
        case .sync:
            return "Keep a copy of a team's documents in a folder on this Mac."
        }
    }
}

/// What the menu asks the console window to show: a section and, when the
/// menu line is about one team, that team first. The page listens for
/// `tray://section/<section>` and reads the team from the event's `detail`;
/// a team it does not list is ignored. The Windows tray sends the same event
/// and payload.
public struct ConsoleTarget: Equatable, Sendable {
    public let section: ConsoleSection
    public let executorId: String?

    public init(section: ConsoleSection, executorId: String? = nil) {
        self.section = section
        self.executorId = executorId
    }

    public var eventName: String { "tray://section/\(section.rawValue)" }

    /// The JavaScript that delivers the event to the page. The payload is
    /// JSON, so no team id can break out of it.
    public var script: String {
        var detail = "null"
        if let executorId,
           let data = try? JSONSerialization.data(withJSONObject: ["executorId": executorId]),
           let json = String(data: data, encoding: .utf8) {
            detail = json
        }
        return "window.dispatchEvent(new CustomEvent('\(eventName)', { detail: \(detail) }))"
    }
}
