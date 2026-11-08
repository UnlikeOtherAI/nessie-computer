import XCTest

final class ExecutorCLIInvocationTests: XCTestCase {
    private let stateDirectory = "/private/state"

    /// The runtime owns the keys and picks the default folders. The app sends
    /// only its explicit replace choice through stdin, never a folder or an
    /// invitation credential.
    func testPairingLeavesFoldersToTheRuntimeAndKeepsInputOffTheProcessList() throws {
        let invocation = try ExecutorCLI.pairingStart(
            apiBaseUrl: "https://api.nessie.works",
            replace: true,
            stateDirectory: stateDirectory
        )
        XCTAssertEqual(invocation.arguments.first, "pairing-start")
        XCTAssertTrue(invocation.arguments.contains("--pairing-input-stdin"))
        XCTAssertTrue(invocation.arguments.contains("--json"))
        XCTAssertFalse(invocation.arguments.contains("--challenge"))
        XCTAssertFalse(invocation.arguments.contains("--workspace"))

        let payload = try XCTUnwrap(invocation.standardInput)
        let parsed = try XCTUnwrap(
            JSONSerialization.jsonObject(with: payload) as? [String: Any]
        )
        XCTAssertEqual(parsed as NSDictionary, ["replace": true] as NSDictionary)
    }

    /// Removal names the connection's own directory and asks for JSON, which
    /// is where the app reads whether Nessie was told.
    func testUnpairRemovesOneNamedConnection() {
        XCTAssertEqual(
            ExecutorCLI.unpair(stateDirectory: stateDirectory).arguments,
            ["unpair", "--json", "--state-dir", stateDirectory]
        )
        XCTAssertNil(ExecutorCLI.unpair(stateDirectory: stateDirectory).standardInput)
    }

    /// The configure call states all three parts of the local policy, because the
    /// CLI reads all three: a panel that sent only the part it was editing would
    /// be asking the CLI to guess at the rest.
    func testConfigureStatesTheWholeLocalPolicyOnStandardInput() throws {
        let invocation = try ExecutorCLI.configure(
            operationKeys: ["file.read", "sandbox.stop"],
            workspaceFolders: [
                ExecutorDescription.Folder(name: "nessie", path: "/private/workspace"),
                ExecutorDescription.Folder(name: "notes", path: "/private/notes")
            ],
            commandAllowlist: ["git", "node"],
            stateDirectory: stateDirectory
        )
        XCTAssertEqual(
            invocation.arguments,
            ["configure", "--configuration-input-stdin", "--state-dir", stateDirectory]
        )
        XCTAssertFalse(invocation.arguments.contains("--tools"))
        XCTAssertFalse(invocation.arguments.contains("--operations"))
        XCTAssertFalse(invocation.arguments.contains("--folder"))

        let payload = try XCTUnwrap(invocation.standardInput)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: payload) as? [String: Any])
        XCTAssertEqual(parsed["operationKeys"] as? [String], ["file.read", "sandbox.stop"])
        XCTAssertEqual(parsed["commandAllowlist"] as? [String], ["git", "node"])
        // The named form, never `workspaceRoot`: the single spelling derives a
        // name from the directory, which would rename a person's folder every
        // time this app re-stated a policy it was not editing.
        XCTAssertNil(parsed["workspaceRoot"])
        let folders = try XCTUnwrap(parsed["workspaceFolders"] as? [[String: String]])
        XCTAssertEqual(folders, [
            ["name": "nessie", "path": "/private/workspace"],
            ["name": "notes", "path": "/private/notes"]
        ])
    }

    /// An emptied list has to be sent as `[]` rather than omitted: an absent
    /// `commandAllowlist` is the CLI's instruction to *keep* the programs the
    /// policy already names.
    func testAnEmptiedAllowlistIsSentExplicitly() throws {
        let invocation = try ExecutorCLI.configure(
            operationKeys: ["file.read"],
            workspaceFolders: [ExecutorDescription.Folder(name: "nessie", path: "/private/workspace")],
            commandAllowlist: [],
            stateDirectory: stateDirectory
        )
        let payload = try XCTUnwrap(invocation.standardInput)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: payload) as? [String: Any])
        XCTAssertEqual(parsed["commandAllowlist"] as? [String], [])
    }

    /// The daemon is spawned with the pipe that makes supervision real. Without
    /// `--parent-liveness-stdin` the daemon would outlive the app that started it.
    func testServeHoldsTheParentLivenessPipe() {
        let invocation = ExecutorCLI.serve(stateDirectory: stateDirectory)
        XCTAssertEqual(
            invocation.arguments,
            ["serve", "--parent-liveness-stdin", "--state-dir", stateDirectory]
        )
        XCTAssertNil(invocation.standardInput)
    }

    func testDescribeAndConnectAreReadsWithNoInput() {
        XCTAssertEqual(
            ExecutorCLI.describe(stateDirectory: stateDirectory).arguments,
            ["describe", "--state-dir", stateDirectory]
        )
        XCTAssertNil(ExecutorCLI.describe(stateDirectory: stateDirectory).standardInput)
        XCTAssertEqual(
            ExecutorCLI.connect(stateDirectory: stateDirectory).arguments,
            ["connect", "--state-dir", stateDirectory]
        )
    }

    func testPairingStatusAndCancelAreTheOnlyAttemptCommands() {
        XCTAssertEqual(
            ExecutorCLI.pairingStatus(stateDirectory: stateDirectory).arguments,
            ["pairing-status", "--json", "--state-dir", stateDirectory]
        )
        XCTAssertEqual(
            ExecutorCLI.pairingCancel(stateDirectory: stateDirectory).arguments,
            ["pairing-cancel", "--json", "--state-dir", stateDirectory]
        )
    }

    /// Pause and Resume are their own verbs: neither is a stop, and neither
    /// carries anything on standard input.
    func testPauseAndResumeNameOnlyTheTeam() {
        XCTAssertEqual(
            ExecutorCLI.pause(stateDirectory: stateDirectory).arguments, ["pause", "--state-dir", stateDirectory]
        )
        XCTAssertEqual(
            ExecutorCLI.resume(stateDirectory: stateDirectory).arguments, ["resume", "--state-dir", stateDirectory]
        )
        XCTAssertNil(ExecutorCLI.pause(stateDirectory: stateDirectory).standardInput)
    }

    func testRequestsAreReadAsJSON() {
        XCTAssertEqual(
            ExecutorCLI.programRequests(stateDirectory: stateDirectory).arguments,
            ["program-requests", "--state-dir", stateDirectory, "--json"]
        )
    }

    /// The sessions agents are working in are read as JSON; a Stop names one
    /// session by its UUID, which is checked before it reaches `argv`.
    func testSessionsAndStopNameOnlyTheTeamAndASessionUUID() throws {
        XCTAssertEqual(
            ExecutorCLI.sessions(stateDirectory: stateDirectory).arguments,
            ["sessions", "--state-dir", stateDirectory, "--json"]
        )
        let id = "0b0c3a40-6f1e-4f7e-9d3b-2d1b8f1e4c11"
        XCTAssertEqual(
            try ExecutorCLI.stopSession(id: id, stateDirectory: stateDirectory).arguments,
            ["session", "stop", "--state-dir", stateDirectory, "--id", id, "--json"]
        )
        for refused in ["../escape", "--json", "", "0b0c3a40-6f1e-4f7e-9d3b-2d1b8f1e4c1"] {
            XCTAssertThrowsError(try ExecutorCLI.stopSession(id: refused, stateDirectory: stateDirectory), refused)
        }
    }

    /// The bridge passes the CLI's sessions through with the team added, and
    /// refuses anything that is not a list of sessions.
    func testSessionRowsCarryTheTeamAndRefuseAnythingElse() throws {
        let json = #"[{"sessionId":"0b0c3a40-6f1e-4f7e-9d3b-2d1b8f1e4c11","agentName":"Sales agent","#
            + #""startedAt":"2026-11-08T12:00:00.000Z","commands":[{"id":"c","kind":"program","status":"running","#
            + #""program":"npm","args":["test"]}]}]"#
        let data = Data(json.utf8)
        let rows = try WorkingSessions.consoleRows(data, executorId: "team-1")
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0]["executorId"] as? String, "team-1")
        XCTAssertEqual(rows[0]["agentName"] as? String, "Sales agent")
        XCTAssertEqual((rows[0]["commands"] as? [[String: Any]])?.first?["program"] as? String, "npm")
        XCTAssertEqual(try WorkingSessions.consoleRows(Data("[]".utf8), executorId: "team-1").count, 0)
        let refusedLists = [
            #"{"error":{"code":"X"}}"#,
            #"[{"sessionId":"../x","commands":[]}]"#,
            #"[{"sessionId":"0b0c3a40-6f1e-4f7e-9d3b-2d1b8f1e4c11"}]"#
        ]
        for refused in refusedLists {
            XCTAssertThrowsError(try WorkingSessions.consoleRows(Data(refused.utf8), executorId: "team-1"), refused)
        }
    }
}
