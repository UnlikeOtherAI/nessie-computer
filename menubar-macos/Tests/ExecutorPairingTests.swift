import XCTest

final class ExecutorPairingTests: XCTestCase {
    private func decode(_ value: [String: Any]) throws -> ExecutorPairing {
        try ExecutorPairing.decode(JSONSerialization.data(withJSONObject: value))
    }

    func testCodePreservesLeadingZeroesAndRequiresExactlyEightASCIIDigits() throws {
        let waiting: [String: Any] = [
            "status": "waiting", "code": "00123456", "expiresAt": "2026-09-21T12:00:00.123Z",
            "fingerprint": "SHA256:machine-key"
        ]
        let state = try decode(waiting)
        XCTAssertEqual(state.code, "00123456")
        XCTAssertNotNil(state.expiration)
        XCTAssertTrue(state.isPending)
        XCTAssertFalse(state.isPaired)
        // Nessie confirms this computer by name now; no fingerprint is shown or needed.
        var withoutFingerprint = waiting
        withoutFingerprint.removeValue(forKey: "fingerprint")
        XCTAssertEqual(try decode(withoutFingerprint).code, "00123456")
        for invalid in ["1234567", "123456789", "ABCDEFGH", "１２３４５６７８", "1234 567"] {
            var payload = waiting
            payload["code"] = invalid
            XCTAssertThrowsError(try decode(payload), invalid)
        }
    }

    func testThereIsNoConfirmationStepOnThisMac() {
        // The claim in Nessie completes the pairing; the runtime never asks here.
        XCTAssertThrowsError(try decode([
            "status": "confirmation", "organizationName": "UnlikeOtherAI", "fingerprint": "SHA256:machine-key",
            "expiresAt": "2026-09-21T12:00:00Z"
        ]))
    }

    func testAClaimedCodeReadsPairedWithTheTeamThatTookThisMac() throws {
        let state = try decode([
            "status": "paired", "organizationName": "UnlikeOtherAI", "teamName": "Platform",
            "executorId": "team-0", "fingerprint": "SHA256:machine-key", "expiresAt": "2026-09-21T12:00:00Z"
        ])
        XCTAssertTrue(state.isPaired)
        XCTAssertFalse(state.isPending)
        XCTAssertEqual(state.teamName, "Platform")
        XCTAssertEqual(state.organizationName, "UnlikeOtherAI")
    }

    func testPairedConnectionUsesLiveNamesWithoutRequiringAPendingCode() throws {
        let state = try decode([
            "status": "paired", "organizationName": "Example", "teamName": NSNull()
        ])
        XCTAssertTrue(state.isPaired)
        XCTAssertFalse(state.isPending)
        XCTAssertEqual(state.organizationName, "Example")
        XCTAssertNil(state.teamName)
        XCTAssertNil(state.expiration)
    }

    func testUnknownStateAndUnparseableExpirationAreRefused() {
        XCTAssertThrowsError(try decode(["status": "confirmedAutomatically"]))
        XCTAssertThrowsError(try decode([
            "status": "waiting", "code": "12345678", "expiresAt": "later"
        ]))
    }

    func testExpiredAttemptKeepsCancellationReachableUntilRuntimeClearsIt() throws {
        let expired = try decode(["status": "expired"])
        XCTAssertFalse(expired.isPending)
        XCTAssertTrue(expired.isAttemptOpen)
        XCTAssertFalse(try decode(["status": "cancelled"]).isAttemptOpen)
        XCTAssertFalse(try decode(["status": "idle"]).isAttemptOpen)
    }

    func testCleanupRefusalShowsTheRemedyWithoutRenderingRuntimeMessages() {
        let known = #"{"error":{"code":"workspace_cleanup_required","message":"secret path"}}"#
        let message = ExecutorPairing.failureMessage(from: Data(known.utf8))
        XCTAssertTrue(message.contains("Remove every local draft"))
        XCTAssertTrue(message.contains("stop every sandbox"))
        XCTAssertFalse(message.contains("secret path"))
        for unknown in [
            #"{"error":{"code":"unexpected","message":"secret path"}}"#,
            "workspace_cleanup_required secret path"
        ] {
            XCTAssertEqual(
                ExecutorPairing.failureMessage(from: Data(unknown.utf8)), ExecutorPairing.genericFailureMessage
            )
        }
    }
}
