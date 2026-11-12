import Foundation

/// What a team is called everywhere this app names one: `{team} · {organisation}`.
///
/// The names come from the CLI's pairing status, which answers the label saved
/// in the team's folder (`docs/team-names.md`) without asking anyone: display
/// only, never an authority. A team that has never had a name is never shown
/// by its id or its API address; it says so instead.
public struct TeamNames: Equatable, Sendable {
    public let executorId: String
    public let teamName: String?
    public let organizationName: String?
    public let apiBaseUrl: String?

    public init(executorId: String, teamName: String?, organizationName: String?, apiBaseUrl: String?) {
        self.executorId = executorId
        self.teamName = teamName
        self.organizationName = organizationName
        self.apiBaseUrl = apiBaseUrl
    }
}

public enum TeamLabel {
    /// Every team's label, by executor id. Two teams that would read the same
    /// get their server's host after the name, so a person can tell them apart.
    public static func labels(for teams: [TeamNames], language: NativeLanguage = .current) -> [String: String] {
        let plain = teams.map { (team: $0, label: label($0, language: language)) }
        var counts: [String: Int] = [:]
        plain.forEach { counts[$0.label, default: 0] += 1 }
        var labels: [String: String] = [:]
        for entry in plain {
            let host = entry.team.apiBaseUrl.flatMap { URLComponents(string: $0)?.host }
            if counts[entry.label, default: 0] > 1, let host, !host.isEmpty {
                labels[entry.team.executorId] = "\(entry.label) (\(host))"
            } else {
                labels[entry.team.executorId] = entry.label
            }
        }
        return labels
    }

    private static func label(_ team: TeamNames, language: NativeLanguage) -> String {
        let parts = [team.teamName, team.organizationName]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? Word.teamNameUnavailable.text(in: language) : parts.joined(separator: " · ")
    }
}

/// What a `team-names` call says went wrong (`src/team-names.ts`): one line per
/// server that did not answer and per team it did not name, by status and code
/// only. The app writes each to its log rather than dropping it.
public enum TeamNamesFailures {
    private static let prefix = "[nessie-executor] team names:"

    public static func lines(in standardError: String) -> [String] {
        standardError.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasPrefix(prefix) }
            .prefix(64)
            .map { String($0.dropFirst("[nessie-executor] ".count).prefix(400)) }
    }
}
