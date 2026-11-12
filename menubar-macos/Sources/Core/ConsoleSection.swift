import Foundation

/// The window's tabs. Every tab follows the team chosen in the dropdown above
/// them; Settings shows that team first and the whole computer after it.
public enum ConsoleSection: String, CaseIterable, Sendable {
    case access
    case documents
    // swiftlint:disable:next identifier_name
    case ai
    case settings
}

/// What the app asks the window to show: a section — or, with none, the
/// window as the person left it, on the tab last used — and, when the request
/// is about one team, that team first. The page listens for
/// `tray://section/<section>` and `tray://open` and reads the team from the
/// event's `detail`; a team it does not list is ignored. The Windows tray sends
/// the same events and payload.
public struct ConsoleTarget: Equatable, Sendable {
    public let section: ConsoleSection?
    public let executorId: String?

    public init(section: ConsoleSection? = nil, executorId: String? = nil) {
        self.section = section
        self.executorId = executorId
    }

    public var eventName: String {
        section.map { "tray://section/\($0.rawValue)" } ?? "tray://open"
    }

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

    /// Opens Add another team, which asks for a pairing code at once.
    public static let connectScript = "window.dispatchEvent(new CustomEvent('tray://connect', { detail: null }))"
}
