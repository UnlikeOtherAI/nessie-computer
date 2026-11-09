import Foundation

/// A program an agent asked to start that the team's rules did not allow yet.
/// The daemon holds the command until the owner answers on this computer or
/// the request expires; `program-requests --json` lists the open ones.
public struct ProgramRequest: Equatable, Decodable, Sendable {
    public let id: String
    public let program: String
    public let args: [String]
    public let agentName: String?
    public let requestedAt: String
    public let expiresAt: String

    public static func decodeList(_ data: Data) throws -> [ProgramRequest] {
        try JSONDecoder().decode([ProgramRequest].self, from: data)
    }

    /// Field order and names as the bridge hands them to the console.
    public func consoleRow(executorId: String) -> [String: Any] {
        var row: [String: Any] = [
            "executorId": executorId, "id": id, "program": program, "args": args,
            "requestedAt": requestedAt, "expiresAt": expiresAt
        ]
        if let agentName { row["agentName"] = agentName }
        return row
    }
}

/// The owner's answer, in the CLI's words.
public enum ProgramRequestAnswer: String, CaseIterable, Sendable {
    case once
    case always
    case deny
}

/// The ids a request may have. The id names a file in the state directory and
/// travels in `argv`, so nothing that could climb out of the directory, hide a
/// separator or read as a flag (a leading `-`) is passed on.
public enum ProgramRequestID {
    public static func isValid(_ value: String) -> Bool {
        let alphanumerics = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        let allowed = alphanumerics.union(CharacterSet(charactersIn: "-_"))
        guard let first = value.unicodeScalars.first, alphanumerics.contains(first) else { return false }
        return value.utf8.count <= 128 && value.unicodeScalars.allSatisfy { allowed.contains($0) }
    }
}

/// The notification a request becomes. Agents choose the program and its
/// arguments, so both are shown as plain text: control characters are
/// removed, a path is shortened to its file name in the button, and long text
/// is cut rather than wrapped into a wall.
public struct ProgramRequestNotice: Equatable, Sendable {
    public static let categoryPrefix = "program-request"

    public let identifier: String
    public let categoryIdentifier: String
    public let title: String
    public let body: String
    public let allowOnce: String
    public let alwaysAllow: String
    public let dontAllow: String

    public init(request: ProgramRequest, executorId: String, teamLabel: String, language: NativeLanguage = .current) {
        let program = Self.plain(request.program, limit: 80)
        let shortProgram = Self.plain((request.program as NSString).lastPathComponent, limit: 32)
        let agent = request.agentName.map { Self.plain($0, limit: 60) }.flatMap { $0.isEmpty ? nil : $0 }
        let command = Self.plain(([request.program] + request.args).joined(separator: " "), limit: 160)
        identifier = Self.identifier(executorId: executorId, requestId: request.id)
        // One category per program, because "Always allow git" names the
        // program in its button and a category's buttons are fixed.
        categoryIdentifier = "\(Self.categoryPrefix).\(shortProgram)"
        title = Word.programRequestTitle(agent: agent, program: shortProgram.isEmpty ? program : shortProgram)
            .text(in: language)
        body = Word.programRequestBody(team: teamLabel, command: command).text(in: language)
        allowOnce = Word.allowOnce.text(in: language)
        alwaysAllow = Word.alwaysAllow(program: shortProgram).text(in: language)
        dontAllow = Word.dontAllow.text(in: language)
    }

    public static func identifier(executorId: String, requestId: String) -> String {
        "\(categoryPrefix).\(executorId).\(requestId)"
    }

    static func plain(_ text: String, limit: Int) -> String {
        let cleaned = String(String.UnicodeScalarView(text.unicodeScalars.map {
            CharacterSet.controlCharacters.contains($0) ? " " : $0
        })).trimmingCharacters(in: .whitespaces)
        guard cleaned.count > limit else { return cleaned }
        return String(cleaned.prefix(limit - 1)) + "…"
    }
}

/// Which open requests are new since the last look, and which notifications
/// to take back because their request was answered or expired.
public struct ProgramRequestDelivery: Equatable, Sendable {
    public let post: [String]
    public let withdraw: [String]

    public init(open: Set<String>, alreadyPosted: Set<String>) {
        post = open.subtracting(alreadyPosted).sorted()
        withdraw = alreadyPosted.subtracting(open).sorted()
    }
}
