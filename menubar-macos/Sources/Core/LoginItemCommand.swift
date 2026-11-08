import Foundation

/// `--login-item status|on|off`: how `nessie-computer settings login` changes
/// **Open Nessie Computer when I log in**. Only this app can register its own
/// login item, so the command line runs this app's executable with these
/// arguments; it answers with one JSON line and exits without a status item,
/// a window or a daemon.
public enum LoginItemCommand: Equatable, Sendable {
    case status
    case set(Bool)

    /// The request in this process's arguments, or `nil` when it was started
    /// as the app. Anything else after the switch is not this command.
    public static func parse(_ arguments: [String]) -> LoginItemCommand? {
        guard arguments.count == 3, arguments[1] == "--login-item" else { return nil }
        switch arguments[2] {
        case "status": return .status
        case "on": return .set(true)
        case "off": return .set(false)
        default: return nil
        }
    }

    /// The answer the command line reads: the switch as it is now, or why it
    /// could not be changed.
    public static func answer(enabled: Bool) -> String { "{\"enabled\":\(enabled)}" }

    public static func answer(refusal: String) -> String { "{\"error\":\"\(refusal)\"}" }
}
