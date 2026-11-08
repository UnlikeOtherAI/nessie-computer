import XCTest

/// The Sync tab's calls to `nessie-executor sync`: a folder path, a conflict
/// and a trash entry travel on standard input, and the page cannot add a
/// field, a command or an address the console does not send.
final class ExecutorCLISyncTests: XCTestCase {
    private let stateDirectory = "/private/state"
    private let batchId = "5a0e6b2c-8d7f-4e19-b3c2-6f1d9e4a7b10"
    private let conflictId = "7d1c5d8e-2f4b-4c3a-9a51-0b6f0d2a1c01"

    private func payload(_ invocation: ExecutorCLIInvocation) throws -> NSDictionary {
        let data = try XCTUnwrap(invocation.standardInput)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    func testStatusAndTrashReadTheNamedConnection() {
        XCTAssertEqual(
            ExecutorCLI.syncStatus(stateDirectory: stateDirectory).arguments,
            ["sync", "--state-dir", stateDirectory, "status", "--json"]
        )
        XCTAssertNil(ExecutorCLI.syncStatus(stateDirectory: stateDirectory).standardInput)
        XCTAssertEqual(
            ExecutorCLI.syncTrashList(stateDirectory: stateDirectory).arguments,
            ["sync", "--state-dir", stateDirectory, "trash", "--json"]
        )
    }

    func testAFolderChoiceTravelsOnStandardInputOnly() throws {
        let root = "/Users/person/Documents/Nessie"
        let invocation = try ExecutorCLI.syncChange(
            ["command": "configure", "root": root, "enabled": true, "acceptExistingFiles": false],
            stateDirectory: stateDirectory
        )
        XCTAssertEqual(invocation.arguments, ["sync", "--state-dir", stateDirectory, "--input-stdin", "--json"])
        XCTAssertFalse(invocation.arguments.contains { $0.contains("Documents") })
        XCTAssertEqual(
            try payload(invocation),
            ["command": "configure", "root": root, "enabled": true, "acceptExistingFiles": false] as NSDictionary
        )
    }

    func testPauseAndHeldDeletionsAreTheirOwnCommands() throws {
        let pause = try ExecutorCLI.syncChange(["command": "pause", "paused": true], stateDirectory: stateDirectory)
        XCTAssertEqual(try payload(pause), ["command": "pause", "paused": true] as NSDictionary)
        let held = try ExecutorCLI.syncChange(
            ["command": "held_deletes", "batchId": batchId, "decision": "restore"], stateDirectory: stateDirectory
        )
        XCTAssertEqual(
            try payload(held),
            ["command": "held_deletes", "batchId": batchId, "decision": "restore"] as NSDictionary
        )
    }

    func testOnlyKnownChangesWithExactlyTheirOwnFieldsPass() {
        let refused: [[String: Any]] = [
            ["command": "pause", "paused": true, "root": "/elsewhere"],
            ["command": "pause", "paused": "yes"],
            ["command": "configure", "root": "", "enabled": true, "acceptExistingFiles": false],
            ["command": "configure", "root": "/Users/person/Nessie", "enabled": true],
            ["command": "held_deletes", "batchId": "latest", "decision": "confirm"],
            ["command": "held_deletes", "batchId": batchId, "decision": "purge"],
            ["command": "resolve", "clientConflictId": conflictId, "resolution": "keep_mine"],
            ["command": "uninstall"]
        ]
        for command in refused {
            XCTAssertThrowsError(try ExecutorCLI.syncChange(command, stateDirectory: stateDirectory), "\(command)")
        }
    }

    func testAResolutionNamesOneConflictAndOneKnownChoice() throws {
        let invocation = try ExecutorCLI.syncResolve(
            clientConflictId: conflictId, resolution: "keep_nessie", stateDirectory: stateDirectory
        )
        XCTAssertEqual(
            try payload(invocation),
            ["command": "resolve", "clientConflictId": conflictId, "resolution": "keep_nessie"] as NSDictionary
        )
        XCTAssertThrowsError(try ExecutorCLI.syncResolve(
            clientConflictId: conflictId, resolution: "delete", stateDirectory: stateDirectory
        ))
        XCTAssertThrowsError(try ExecutorCLI.syncResolve(
            clientConflictId: "../../etc", resolution: "dismiss", stateDirectory: stateDirectory
        ))
    }

    func testATrashEntryIsRestoredByTheCLIsOwnName() throws {
        let entry = "2026-11-02/Product/Old plan.md"
        let invocation = try ExecutorCLI.syncRestoreTrash(entryId: entry, stateDirectory: stateDirectory)
        XCTAssertFalse(invocation.arguments.contains(entry))
        XCTAssertEqual(try payload(invocation), ["command": "restore_trash", "entryId": entry] as NSDictionary)
        XCTAssertThrowsError(try ExecutorCLI.syncRestoreTrash(entryId: "bad\nentry", stateDirectory: stateDirectory))
    }

    func testShowInFolderNeverClimbsOutOfTheTeamFolder() throws {
        XCTAssertEqual(
            try ExecutorCLI.syncSegments(teamLabel: "Platform", relPath: "Product/Plan.md"),
            ["Platform", "Product", "Plan.md"]
        )
        for path in ["../secret.txt", "Product/../../x", "/abs", "a\\b", "a//b", "./x"] {
            XCTAssertThrowsError(try ExecutorCLI.syncSegments(teamLabel: "Platform", relPath: path), path)
        }
        XCTAssertThrowsError(try ExecutorCLI.syncSegments(teamLabel: "..", relPath: "x"))
        // A team folder inside its organisation's: both are steps of their own, each checked for a link.
        XCTAssertEqual(
            try ExecutorCLI.syncSegments(teamLabel: "UnlikeOtherAI/Platform", relPath: "Plan.md"),
            ["UnlikeOtherAI", "Platform", "Plan.md"]
        )
        for team in ["UnlikeOtherAI/..", "../Platform", "/Platform", "UnlikeOtherAI/", "A/B/C"] {
            XCTAssertThrowsError(try ExecutorCLI.syncSegments(teamLabel: team, relPath: "Plan.md"), team)
        }
    }

    func testNessieOpensOnlyOverHTTPS() throws {
        let address = "https://unlikeotherai.nessie.works/platform/computers/team?tab=sync"
        XCTAssertEqual(try ExecutorCLI.syncManageURL(address, isDevelopmentBuild: false).absoluteString, address)
        XCTAssertThrowsError(try ExecutorCLI.syncManageURL("http://nessie.works/x", isDevelopmentBuild: false))
        XCTAssertThrowsError(try ExecutorCLI.syncManageURL("http://localhost:5455/x", isDevelopmentBuild: false))
        XCTAssertNoThrow(try ExecutorCLI.syncManageURL("http://localhost:5455/x", isDevelopmentBuild: true))
        XCTAssertThrowsError(try ExecutorCLI.syncManageURL("file:///etc/passwd", isDevelopmentBuild: true))
        XCTAssertThrowsError(
            try ExecutorCLI.syncManageURL("https://user:secret@nessie.works/", isDevelopmentBuild: false)
        )
    }
}
