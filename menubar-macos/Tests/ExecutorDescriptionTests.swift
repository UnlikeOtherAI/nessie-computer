import XCTest

final class ExecutorDescriptionTests: XCTestCase {
    /// Decoding the CLI's own bytes is the proof the panels render what `describe`
    /// answers rather than a shape this app invented.
    func testDecodesWhatDescribePrinted() throws {
        let description = try ExecutorDescription.decode(Data(describeFixtureJSON.utf8))
        XCTAssertEqual(description.apiBaseUrl, "http://127.0.0.1:5454")
        XCTAssertEqual(description.executorId, "32b7de69-e303-46d6-b864-8a99a80d25e6")
        XCTAssertEqual(description.policy.revision, 5)
        XCTAssertEqual(description.policy.permittedPrograms, ["git *", "node", "npm run *"])
        XCTAssertEqual(description.policy.limits.maxSessions, 1)
        XCTAssertEqual(description.reach.folders.map(\.name), ["workspace"])
        XCTAssertEqual(
            description.reach.folders.map(\.path),
            ["/Users/dictator/.nessie-executor-dev/workspace"]
        )
        XCTAssertEqual(description.reach.guestSessions, .available)
        // A descriptor signed before folders had names carries no names of its
        // own; the folder below is still the one folder it stands for.
        XCTAssertTrue(description.policy.workspaceFolders.isEmpty)
        XCTAssertTrue(description.reach.allowedOrigins.isEmpty)
        XCTAssertFalse(description.sandbox.browserConfigured)
    }

    /// `describe` deliberately never carries the machine key. Nothing in this
    /// type could hold one, and this states that as a test so a future field
    /// cannot quietly add one.
    func testTheDescriptionHasNowhereToPutACredential() throws {
        let parsed = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(describeFixtureJSON.utf8)) as? [String: Any]
        )
        XCTAssertEqual(Set(parsed.keys), ["apiBaseUrl", "executorId", "policy", "reach", "sandbox"])
    }

    func testCommandRunIsReadFromTheOperationList() throws {
        let withoutCommand = try ExecutorDescription.decode(Data(describeFixtureJSON.utf8))
        XCTAssertFalse(withoutCommand.commandRunEnabled)

        let withCommand = describeFixtureJSON.replacingOccurrences(
            of: "\"sandbox.stop\"",
            with: "\"sandbox.stop\",\n      \"command.run\""
        )
        XCTAssertTrue(try ExecutorDescription.decode(Data(withCommand.utf8)).commandRunEnabled)
    }

    /// A guest VM mounts one workspace, so more than one folder is a refusal the
    /// reach surface has to state rather than a detail it can hide.
    func testSeveralFoldersRefuseGuestSessionsAndSayWhy() throws {
        let several = describeFixtureJSON
            .replacingOccurrences(of: "\"guestSessions\": \"available\"",
                                  with: "\"guestSessions\": \"refused_multiple_folders\"")
        let description = try ExecutorDescription.decode(Data(several.utf8))
        XCTAssertEqual(description.reach.guestSessions, .refusedMultipleFolders)
        XCTAssertTrue(description.guestSessionNote.contains("refuse to start"))
        XCTAssertNotEqual(
            description.guestSessionNote,
            (try ExecutorDescription.decode(Data(describeFixtureJSON.utf8))).guestSessionNote
        )
    }
}
