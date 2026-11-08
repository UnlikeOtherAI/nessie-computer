import XCTest

/// Program requests: the CLI's list, the owner's answer and the notification.
final class ProgramRequestTests: XCTestCase {
    private let listJSON = """
    [
      { "id": "req-1", "program": "/opt/homebrew/bin/terraform", "args": ["plan", "-out", "x"],
        "agentName": "Build helper", "requestedAt": "2026-11-08T10:00:00.000Z",
        "expiresAt": "2026-11-08T10:02:00.000Z" },
      { "id": "req_2", "program": "make", "args": [],
        "requestedAt": "2026-11-08T10:00:05.000Z", "expiresAt": "2026-11-08T10:02:05.000Z" }
    ]
    """

    func testTheCLIListDecodesAndReachesTheConsoleWithItsTeam() throws {
        let requests = try ProgramRequest.decodeList(Data(listJSON.utf8))
        XCTAssertEqual(requests.map(\.id), ["req-1", "req_2"])
        XCTAssertNil(requests[1].agentName)
        let row = requests[0].consoleRow(executorId: "team-a")
        XCTAssertEqual(row["executorId"] as? String, "team-a")
        XCTAssertEqual(row["program"] as? String, "/opt/homebrew/bin/terraform")
        XCTAssertEqual(row["args"] as? [String], ["plan", "-out", "x"])
        XCTAssertEqual(row["agentName"] as? String, "Build helper")
        XCTAssertNil(requests[1].consoleRow(executorId: "team-a")["agentName"], "absent, not empty")
    }

    func testTheAnswerReachesTheCLIOnlyWithASafeId() throws {
        let invocation = try ExecutorCLI.answerProgramRequest(id: "req-1", answer: .always, stateDirectory: "/s")
        XCTAssertEqual(invocation.arguments, [
            "program-request", "answer", "--state-dir", "/s", "--id", "req-1", "--answer", "always"
        ])
        XCTAssertEqual(ProgramRequestAnswer.allCases.map(\.rawValue), ["once", "always", "deny"])
        for hostile in ["", "../owner-pause", "a/b", "a b", "a.b", String(repeating: "x", count: 129), "--answer"] {
            XCTAssertThrowsError(
                try ExecutorCLI.answerProgramRequest(id: hostile, answer: .once, stateDirectory: "/s"), hostile
            )
        }
    }

    /// The notification names the agent, the program and the team, with the
    /// three answers; "Always allow" names the program, not its path.
    func testTheNotificationSaysWhoWantsWhatWhere() throws {
        let request = try ProgramRequest.decodeList(Data(listJSON.utf8))[0]
        let notice = ProgramRequestNotice(
            request: request, executorId: "team-a", teamLabel: "Sales · Acme", language: .britishEnglish
        )
        XCTAssertEqual(notice.title, "Build helper wants to run terraform")
        XCTAssertEqual(notice.body, "Sales · Acme: /opt/homebrew/bin/terraform plan -out x")
        XCTAssertEqual(notice.allowOnce, "Allow once")
        XCTAssertEqual(notice.alwaysAllow, "Always allow terraform")
        XCTAssertEqual(notice.dontAllow, "Don’t allow")
        XCTAssertEqual(notice.identifier, "program-request.team-a.req-1")
        XCTAssertEqual(notice.categoryIdentifier, "program-request.terraform")
        let czech = ProgramRequestNotice(request: request, executorId: "team-a", teamLabel: "T", language: .czech)
        XCTAssertEqual(czech.alwaysAllow, "Vždy povolit terraform")
    }

    /// Agents choose these words, so they cannot break lines or fill the screen.
    func testAgentTextIsPlainAndShort() throws {
        let hostile = """
        [{ "id": "r", "program": "evil\\nprogram", "args": ["\\u0007\(String(repeating: "a", count: 400))"],
           "agentName": "\\n", "requestedAt": "t", "expiresAt": "t" }]
        """
        let request = try ProgramRequest.decodeList(Data(hostile.utf8))[0]
        let notice = ProgramRequestNotice(request: request, executorId: "e", teamLabel: "T", language: .americanEnglish)
        for text in [notice.title, notice.body, notice.alwaysAllow] {
            XCTAssertFalse(text.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }, text)
        }
        XCTAssertTrue(notice.title.hasPrefix("An agent wants to run"), "an empty agent name is no name")
        XCTAssertLessThanOrEqual(notice.body.count, 170)
        XCTAssertTrue(notice.body.hasSuffix("…"))
    }

    /// New requests are posted once; answered or expired ones are taken back.
    func testDeliveryPostsWhatIsNewAndWithdrawsWhatIsGone() {
        let delivery = ProgramRequestDelivery(open: ["a", "b", "c"], alreadyPosted: ["b", "z"])
        XCTAssertEqual(delivery.post, ["a", "c"])
        XCTAssertEqual(delivery.withdraw, ["z"])
        XCTAssertEqual(ProgramRequestDelivery(open: ["a"], alreadyPosted: ["a"]).post, [])
    }
}

final class FailureClassifierTests: XCTestCase {
    /// The console translates by code; this app only has to recognise the
    /// literal the CLI printed, and say nothing when it does not.
    func testKnownRefusalsCarryTheirCode() {
        XCTAssertEqual(FailureClassifier.code(for: "Executor connection is fenced.\n"), "EXECUTOR_CONNECTION_FENCED")
        XCTAssertEqual(
            FailureClassifier.code(for: "Executor descriptor revisions cannot move backwards."),
            "EXECUTOR_DESCRIPTOR_ROLLBACK"
        )
        XCTAssertEqual(FailureClassifier.code(for: "Executor API request timed out."), "EXECUTOR_API_TIMEOUT")
        XCTAssertNil(FailureClassifier.code(for: "Something new from a later runtime."))
        XCTAssertEqual(TeamFailure(classifying: "Executor proof is invalid.").code, "EXECUTOR_DAEMON_PROOF_INVALID")
        XCTAssertEqual(TeamFailure(classifying: "Unknown").message, "Unknown", "the message passes through")
    }

    func testOnlyAStaleRevisionIsProposedAgain() {
        XCTAssertTrue(FailureClassifier.isStaleRevision("Executor descriptor revisions cannot move backwards."))
        XCTAssertTrue(
            FailureClassifier.isStaleRevision("A descriptor revision cannot describe two different policies.")
        )
        XCTAssertFalse(FailureClassifier.isStaleRevision("Executor connection is fenced."))
    }

    /// A fenced connection is never taken back automatically; a timeout is retried.
    func testOnlyRefusalsThatCanHealAreRetried() {
        XCTAssertFalse(FailureClassifier.isRetryable("Executor connection is fenced."))
        XCTAssertFalse(FailureClassifier.isRetryable("Executor proof is invalid."))
        XCTAssertFalse(FailureClassifier.isRetryable("Executor descriptor revisions cannot move backwards."))
        XCTAssertTrue(FailureClassifier.isRetryable("Executor API request timed out."))
        XCTAssertTrue(FailureClassifier.isRetryable("getaddrinfo ENOTFOUND api.nessie.works"))
        XCTAssertEqual(NativeRemedy.allCases.map(\.rawValue), ["reProposePolicy", "openNessie", "restartExecutor"])
    }
}
