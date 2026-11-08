import Foundation

/// `nessie-computer://` links: the way Nessie's web, mail and other apps send a
/// person to a place in this window.
///
/// A link only navigates. It names a tab and, optionally, a team; it never
/// carries a value to save, a command or a path, so following one changes
/// nothing on this computer. Anything this parser does not recognise is
/// refused rather than guessed at.
public enum DeepLink: Equatable, Sendable {
    /// `nessie-computer://open?section=<section>[&team=<executorId>]`
    case open(ConsoleTarget)
    /// `nessie-computer://connect`: Add this computer.
    case connect

    public static let scheme = "nessie-computer"

    public static func parse(_ url: URL) -> DeepLink? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == scheme,
              components.user == nil, components.password == nil, components.port == nil,
              components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              let host = components.host?.lowercased() else { return nil }
        let items = components.queryItems ?? []
        switch host {
        case "connect":
            return items.isEmpty ? .connect : nil
        case "open":
            return open(items)
        default:
            return nil
        }
    }

    /// How a second copy of the app hands the links it was opened with to the
    /// running one: their text, at most eight, in a distributed notification.
    public static let handoverKey = "links"
    private static let handoverMaximum = 8

    public static func handoverUserInfo(_ urls: [URL]) -> [String: Any]? {
        let links = urls.filter { parse($0) != nil }.prefix(handoverMaximum).map(\.absoluteString)
        return links.isEmpty ? nil : [handoverKey: Array(links)]
    }

    /// The links in a handover, parsed again: whoever posted it, only a link
    /// this parser accepts is followed.
    public static func handedOver(_ userInfo: [AnyHashable: Any]?) -> [DeepLink] {
        guard let texts = userInfo?[handoverKey] as? [String] else { return [] }
        return texts.prefix(handoverMaximum).compactMap { URL(string: $0).flatMap(parse) }
    }

    private static func open(_ items: [URLQueryItem]) -> DeepLink? {
        guard Set(items.map(\.name)).isSubset(of: ["section", "team"]),
              items.count == Set(items.map(\.name)).count else { return nil }
        var section = ConsoleSection.overview
        if let named = items.first(where: { $0.name == "section" }) {
            guard let value = named.value.flatMap(ConsoleSection.init(rawValue:)) else { return nil }
            section = value
        }
        var team: String?
        if let named = items.first(where: { $0.name == "team" }) {
            guard let value = named.value, UUID(uuidString: value) != nil else { return nil }
            team = value.lowercased()
        }
        return .open(ConsoleTarget(section: section, executorId: team))
    }
}
