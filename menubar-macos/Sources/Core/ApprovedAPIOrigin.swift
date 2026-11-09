import Foundation

/// Which Nessie this Mac may pair with.
///
/// The rule is `executorPairingOrigins` in `packages/schemas` — the same list
/// the CLI's `--api nessie|deeptest|https://your-nessie.example` reads —
/// restated here rather than widened, the way this file has always restated a
/// rule instead of inventing a second one. `ApprovedAPIOriginTests` pins these
/// strings against that file so the two cannot drift apart quietly.
///
/// It used to be one pinned origin, because pairing hands a machine key to a
/// server and an app that accepted any URL was a way to point somebody's
/// machine at a server nobody reviewed. Nessie is open source and people run
/// their own, so the check does not go away — the choice becomes explicit. Two
/// hosted services are named, so the common cases cannot be typo-squatted, and
/// anything else is a person's own server, shown to them by host at every point
/// where trust is given.
public enum ApprovedAPIOrigin {
    /// A named Nessie, chosen by its name rather than typed.
    public struct Preset: Equatable, Identifiable, Sendable {
        public let id: String
        public let label: String
        public let detail: String
        public let apiBaseUrl: String
    }

    public static let presets: [Preset] = [
        Preset(
            id: "nessie",
            label: "Nessie",
            detail: "The hosted Nessie at nessie.works.",
            apiBaseUrl: "https://api.nessie.works"
        ),
        Preset(
            id: "deeptest",
            label: "DeepTest",
            detail: "The hosted DeepTest at deeptest.live.",
            apiBaseUrl: "https://api.deeptest.live"
        )
    ]

    /// The local API a development build may pair with, and only a development
    /// build. A release that could be talked into plain HTTP would not be one.
    public static let localDevelopment = "http://127.0.0.1:5454"

    public static func preset(_ id: String) -> Preset? {
        presets.first { $0.id == id }
    }

    /// The origin a build starts the choice on. The CLI validates whatever is
    /// finally sent again, so this is a convenience, never an authorization.
    public static func `default`(isDevelopmentBuild: Bool) -> String {
        isDevelopmentBuild ? localDevelopment : presets[0].apiBaseUrl
    }

    /// May this Mac pair with this value, and what exactly would it be pairing
    /// with? A preset id resolves to its pinned origin; anything else must be an
    /// HTTPS origin carrying no credentials, path, query or fragment — a URL
    /// with a path is either a mistake or an attempt to make one host read as
    /// another in a label, and neither should reach a machine key.
    public static func approve(
        _ value: String,
        isDevelopmentBuild: Bool
    ) -> Result<String, ExecutorRefusal> {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if let preset = preset(trimmed) { return .success(preset.apiBaseUrl) }

        guard let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              !host.isEmpty
        else {
            return .failure(ExecutorRefusal(.addressNeedsHTTPS))
        }
        if components.user != nil || components.password != nil {
            return .failure(ExecutorRefusal(.addressHasCredentials))
        }
        let carriesMoreThanAnOrigin = components.query != nil
            || components.fragment != nil
            || !(components.path.isEmpty || components.path == "/")
        if carriesMoreThanAnOrigin {
            return .failure(ExecutorRefusal(.addressHasPath))
        }
        let origin = origin(scheme: scheme, host: host, port: components.port)
        if scheme == "https" { return .success(origin) }
        if isDevelopmentBuild, origin == localDevelopment { return .success(origin) }
        return .failure(ExecutorRefusal(.addressMustBeHTTPS))
    }

    /// How a surface names an origin to the person confirming it. A preset is
    /// named for its service; anything else is the bare host, because "Custom"
    /// alone would hide the one fact that matters.
    public static func label(for origin: String) -> String {
        if let preset = presets.first(where: { $0.apiBaseUrl == origin }) { return preset.label }
        if origin == localDevelopment { return "local development API" }
        guard let host = URLComponents(string: origin)?.host, !host.isEmpty else { return origin }
        return host
    }

    /// Where a person goes to confirm a fingerprint or review a proposal, for
    /// the Nessie this Mac is actually paired with. A hosted Nessie serves its
    /// admin beside its API, so the one rule is `api.` → `app.`; anything else
    /// is a self-hosted origin nobody here can second-guess, and it is offered
    /// as itself.
    ///
    /// While a pairing code is showing, the page opens on Add a computer with
    /// that code filled in (`?create=1&code=<code>`), a one-shot intent the
    /// console strips once it has read it. Only an eight-digit code is passed.
    /// `computerId` opens that team's own computer page rather than the list.
    public static func consoleURL(
        forAPIOrigin apiOrigin: String,
        isDevelopmentBuild: Bool,
        pairingCode: String? = nil,
        computerId: String? = nil
    ) -> URL {
        var components: URLComponents
        if isDevelopmentBuild, apiOrigin == localDevelopment {
            components = URLComponents()
            components.scheme = "http"
            components.host = "localhost"
            components.port = 5455
        } else if let parsed = URLComponents(string: apiOrigin), let host = parsed.host {
            components = parsed
            if host.hasPrefix("api.") { components.host = "app." + host.dropFirst("api.".count) }
        } else {
            return hostedNessieConsole
        }
        components.path = "/admin/computers"
        let identity = { (scalar: Unicode.Scalar) in
            scalar.isASCII && (CharacterSet.alphanumerics.contains(scalar) || scalar == "-")
        }
        if let computerId, !computerId.isEmpty, computerId.utf8.count <= 128,
           computerId.unicodeScalars.allSatisfy(identity) {
            components.path += "/" + computerId
        }
        if let pairingCode, pairingCode.utf8.count == 8, pairingCode.utf8.allSatisfy({ (48...57).contains($0) }) {
            components.queryItems = [
                URLQueryItem(name: "create", value: "1"), URLQueryItem(name: "code", value: pairingCode)
            ]
        }
        return components.url ?? hostedNessieConsole
    }

    /// Whether an origin is the hosted Nessie that the Nessie desktop app
    /// shows. Only then may "Open Nessie" open the app instead of the browser:
    /// the app always loads the hosted service, never a self-hosted one.
    public static func isHostedNessie(_ origin: String) -> Bool {
        guard let hosted = preset("nessie")?.apiBaseUrl else { return false }
        return origin == "nessie" || origin == hosted
    }

    /// Only ever reached by an origin this app already refused to pair with, so
    /// it points at the Nessie the first preset names. Force-unwrapped against a
    /// literal this file owns.
    private static let hostedNessieConsole = URL(string: "https://app.nessie.works/admin/computers")!

    private static func origin(scheme: String, host: String, port: Int?) -> String {
        guard let port, !(scheme == "https" && port == 443), !(scheme == "http" && port == 80) else {
            return "\(scheme)://\(host)"
        }
        return "\(scheme)://\(host):\(port)"
    }
}

/// A refusal a person reads. Every failure this app can produce is one of these,
/// so a panel never has to invent an explanation for a `nil`.
public struct ExecutorRefusal: Error, Equatable, Sendable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }
}
