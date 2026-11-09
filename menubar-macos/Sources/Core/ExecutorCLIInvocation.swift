import Foundation

/// Every way this app speaks to `nessie-executor`, as data.
///
/// The app is a client of that CLI, never a second writer of executor state, so
/// this file is the complete list of what it can ask for. Building the argument
/// vector and the standard-input payload as a value — rather than inside the
/// process-spawning code — is what lets a test assert the one property that
/// matters: a pairing challenge and a workspace path never appear in `argv`,
/// where every process on this Mac could read them.
public struct ExecutorCLIInvocation: Equatable, Sendable {
    public let arguments: [String]
    /// Written to the child's stdin and closed. `nil` means stdin is not a pipe.
    public let standardInput: Data?

    public init(arguments: [String], standardInput: Data? = nil) {
        self.arguments = arguments
        self.standardInput = standardInput
    }
}

public enum ExecutorCLI {
    public static func describe(stateDirectory: String) -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(arguments: ["describe", "--state-dir", stateDirectory])
    }

    public static func connect(stateDirectory: String) -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(arguments: ["connect", "--state-dir", stateDirectory])
    }

    /// The daemon. `--parent-liveness-stdin` is what makes the app's supervision
    /// real: the daemon watches that pipe and tears its guests down when it
    /// closes, so it cannot outlive the app that started it. The same contract
    /// `desktop/src-tauri/src/executor_companion/runtime.rs` uses on macOS.
    public static func serve(stateDirectory: String) -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(arguments: ["serve", "--parent-liveness-stdin", "--state-dir", stateDirectory])
    }

    /// The runtime owns key generation, pending state, replacement and the
    /// default folders a new pairing may reach, so the app names none.
    public static func pairingStart(
        apiBaseUrl: String,
        replace: Bool,
        stateDirectory: String
    ) throws -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(
            arguments: [
                "pairing-start", "--json",
                "--api", apiBaseUrl,
                "--pairing-input-stdin",
                "--state-dir", stateDirectory
            ],
            standardInput: try canonicalJSON(["replace": replace])
        )
    }

    /// Removes one team's connection: the runtime signs off with Nessie and
    /// deletes the connection's state directory. The daemon must be stopped.
    public static func unpair(stateDirectory: String) -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(arguments: ["unpair", "--json", "--state-dir", stateDirectory])
    }

    public static func pairingStatus(stateDirectory: String) -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(arguments: ["pairing-status", "--json", "--state-dir", stateDirectory])
    }

    /// Every team's names in one request per Nessie server, saved as each
    /// team's label (`docs/team-names.md`); folders without a team are skipped.
    public static func teamNames(stateDirectories: [String]) -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(arguments: ["team-names"] + stateDirectories.flatMap { ["--state-dir", $0] } + ["--json"])
    }

    public static func pairingCancel(stateDirectory: String) -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(arguments: ["pairing-cancel", "--json", "--state-dir", stateDirectory])
    }

    /// One local-policy proposal. Operations, folders and permitted commands are
    /// always stated together because that is what `configure
    /// --configuration-input-stdin` reads; a section that changed one of them
    /// re-states the other two exactly as `describe` reported them, so no
    /// section can silently narrow a policy it was not editing.
    ///
    /// The folders go over as `workspaceFolders`, the named form. The older
    /// `workspaceRoot` spelling is still accepted by the CLI, but it derives a
    /// name from the directory — which would rename a person's folder the moment
    /// this app re-stated a policy it was not editing.
    public static func configure(
        operationKeys: [String],
        workspaceFolders: [ExecutorDescription.Folder],
        commandAllowlist: [String],
        stateDirectory: String
    ) throws -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(
            arguments: ["configure", "--configuration-input-stdin", "--state-dir", stateDirectory],
            standardInput: try canonicalJSON([
                "commandAllowlist": commandAllowlist,
                "operationKeys": operationKeys,
                "workspaceFolders": workspaceFolders.map { ["name": $0.name, "path": $0.path] }
            ])
        )
    }

    /// Pause and Resume persist the owner's choice in the team's state
    /// directory and tell its running daemon; neither stops the daemon.
    public static func pause(stateDirectory: String) -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(arguments: ["pause", "--state-dir", stateDirectory])
    }

    public static func resume(stateDirectory: String) -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(arguments: ["resume", "--state-dir", stateDirectory])
    }

    /// The open program requests: `[{ id, program, args, agentName?, requestedAt, expiresAt }]`.
    public static func programRequests(stateDirectory: String) -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(arguments: ["program-requests", "--state-dir", stateDirectory, "--json"])
    }

    /// The owner's answer to one request. The id is checked before it reaches
    /// `argv`, because it names a file in the state directory.
    public static func answerProgramRequest(
        id: String,
        answer: ProgramRequestAnswer,
        stateDirectory: String
    ) throws -> ExecutorCLIInvocation {
        guard ProgramRequestID.isValid(id) else { throw ExecutorRefusal(.invalidRequest) }
        return ExecutorCLIInvocation(arguments: [
            "program-request", "answer", "--state-dir", stateDirectory, "--id", id, "--answer", answer.rawValue
        ])
    }

    /// What agents are doing on this computer for the team: its sessions and
    /// their commands, in the shape the console's Now working reads.
    public static func sessions(stateDirectory: String) -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(arguments: ["sessions", "--state-dir", stateDirectory, "--json"])
    }

    /// The owner's Stop for one session. The id is a UUID, checked before it
    /// reaches `argv`, because it names a file in the state directory.
    public static func stopSession(id: String, stateDirectory: String) throws -> ExecutorCLIInvocation {
        guard WorkingSessions.isSessionID(id) else { throw ExecutorRefusal(.invalidRequest) }
        return ExecutorCLIInvocation(arguments: [
            "session", "stop", "--state-dir", stateDirectory, "--id", id, "--json"
        ])
    }

    private static func canonicalJSON(_ value: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }
}

/// Folder sync. The console names a team, a choice and public identifiers;
/// every change reaches `sync --input-stdin` as JSON the CLI validates again,
/// so a folder path never appears in `argv`.
extension ExecutorCLI {
    static var invalidSyncAction: String { Word.invalidRequest.text }

    private static func sync(_ stateDirectory: String, _ tail: [String]) -> [String] {
        ["sync", "--state-dir", stateDirectory] + tail
    }

    /// `FolderSyncConsoleState` for the connection.
    public static func syncStatus(stateDirectory: String) -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(arguments: sync(stateDirectory, ["status", "--json"]))
    }

    /// The local trash: `{ entries: [{ entryId, relPath, deletedAt }] }`.
    public static func syncTrashList(stateDirectory: String) -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(arguments: sync(stateDirectory, ["trash", "--json"]))
    }

    /// A `configure`, `pause` or `held_deletes` command, rebuilt from typed
    /// values so nothing the page added beyond its own fields is passed on.
    public static func syncChange(
        _ command: [String: Any],
        stateDirectory: String
    ) throws -> ExecutorCLIInvocation {
        let input: [String: Any]
        switch command["command"] as? String {
        case "configure":
            guard let root = command["root"] as? String, !root.isEmpty, root.utf8.count <= 4096,
                  !root.contains("\0"), let enabled = command["enabled"] as? Bool,
                  let accept = command["acceptExistingFiles"] as? Bool else {
                throw ExecutorRefusal(invalidSyncAction)
            }
            input = ["command": "configure", "root": root, "enabled": enabled, "acceptExistingFiles": accept]
        case "pause":
            guard let paused = command["paused"] as? Bool else { throw ExecutorRefusal(invalidSyncAction) }
            input = ["command": "pause", "paused": paused]
        case "held_deletes":
            guard let batchId = command["batchId"] as? String, UUID(uuidString: batchId) != nil,
                  let decision = command["decision"] as? String, ["confirm", "restore"].contains(decision) else {
                throw ExecutorRefusal(invalidSyncAction)
            }
            input = ["command": "held_deletes", "batchId": batchId, "decision": decision]
        default: throw ExecutorRefusal(invalidSyncAction)
        }
        guard Set(command.keys) == Set(input.keys) else { throw ExecutorRefusal(invalidSyncAction) }
        return try syncInput(input, stateDirectory: stateDirectory)
    }

    /// Keep mine, Keep Nessie's or dismiss, for one open conflict.
    public static func syncResolve(
        clientConflictId: String,
        resolution: String,
        stateDirectory: String
    ) throws -> ExecutorCLIInvocation {
        guard UUID(uuidString: clientConflictId) != nil,
              ["keep_mine", "keep_nessie", "dismiss"].contains(resolution) else {
            throw ExecutorRefusal(invalidSyncAction)
        }
        return try syncInput(
            ["command": "resolve", "clientConflictId": clientConflictId, "resolution": resolution],
            stateDirectory: stateDirectory
        )
    }

    /// Puts one trash entry back in the folder; the entry is the CLI's own opaque name for it.
    public static func syncRestoreTrash(entryId: String, stateDirectory: String) throws -> ExecutorCLIInvocation {
        guard !entryId.isEmpty, entryId.utf8.count <= 4096,
              !entryId.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw ExecutorRefusal(invalidSyncAction)
        }
        return try syncInput(["command": "restore_trash", "entryId": entryId], stateDirectory: stateDirectory)
    }

    private static func syncInput(_ input: [String: Any], stateDirectory: String) throws -> ExecutorCLIInvocation {
        ExecutorCLIInvocation(
            arguments: sync(stateDirectory, ["--input-stdin", "--json"]),
            standardInput: try canonicalJSON(input)
        )
    }

    /// The steps from the sync root to a listed conflict's file: the team
    /// folder — its organisation folder and its own (`Org/Team`), or one folder
    /// for a sync named before teams shared a main folder — then the relative
    /// path's segments. Each is checked for a link; none may climb or hide a separator.
    public static func syncSegments(teamLabel: String, relPath: String) throws -> [String] {
        let team = teamLabel.components(separatedBy: "/")
        if team.count > 2 { throw ExecutorRefusal(invalidSyncAction) }
        let segments = team + relPath.components(separatedBy: "/")
        let unsafe = segments.contains { segment in
            segment.isEmpty || segment == "." || segment == ".." || segment.contains("\\") || segment.contains("\0")
        }
        if unsafe { throw ExecutorRefusal(invalidSyncAction) }
        return segments
    }

    /// The handshake's address for this computer's Sync tab: HTTPS only, and
    /// a local address only in a development build.
    public static func syncManageURL(_ address: String, isDevelopmentBuild: Bool) throws -> URL {
        let refusal = ExecutorRefusal(.addressNotOpened)
        guard let components = URLComponents(string: address), let url = components.url,
              let host = components.host, !host.isEmpty, components.user == nil, components.password == nil else {
            throw refusal
        }
        let local = isDevelopmentBuild && components.scheme == "http" && ["localhost", "127.0.0.1"].contains(host)
        guard components.scheme == "https" || local else { throw refusal }
        return url
    }
}
