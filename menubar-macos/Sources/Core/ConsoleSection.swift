import Foundation

/// The window's tabs. Overview and Settings are about the whole computer;
/// Access, Documents and AI follow the team chosen in the window's dropdown.
public enum ConsoleSection: String, CaseIterable, Sendable {
    case overview
    case access
    case documents
    // swiftlint:disable:next identifier_name
    case ai
    case settings
}

/// What the app asks the window to show: a section and, when the request is
/// about one team, that team first. The page listens for
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

    /// Opens Add this computer, which asks for a pairing code at once.
    public static let connectScript = "window.dispatchEvent(new CustomEvent('tray://connect', { detail: null }))"
}
