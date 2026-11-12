import Foundation
import XCTest

final class LocalAIControlTests: XCTestCase {
    func testSwitchTravelsOnStandardInputForTheTeamFolder() throws {
        let invocation = try LocalAIControl.invocation(
            command: "executor_set_local_ai", args: ["engine": "codex", "available": true],
            stateDirectory: "/paired/team"
        )
        XCTAssertEqual(invocation.arguments, [
            "local-inference", "engines", "--operation-stdin", "--state-dir", "/paired/team"
        ])
        let body = try XCTUnwrap(JSONSerialization.jsonObject(
            with: try XCTUnwrap(invocation.standardInput)
        ) as? [String: Any])
        XCTAssertEqual(body["operation"] as? String, "set")
        XCTAssertEqual(body["engine"] as? String, "codex")
        XCTAssertTrue(body["profileId"] is NSNull)
        XCTAssertEqual(body["available"] as? Bool, true)
    }

    func testOnlyKnownEnginesAccountsAndNames() {
        let refused: [(String, [String: Any])] = [
            ("executor_set_local_ai", ["engine": "claude", "available": true]),
            ("executor_set_local_ai", ["engine": "codex"]),
            ("executor_local_ai_sign_in", ["profileId": "../other"]),
            ("executor_local_ai_add_account", ["engine": "codex", "name": "  "]),
            ("executor_local_ai_wipe", [:])
        ]
        for (command, args) in refused {
            XCTAssertThrowsError(try LocalAIControl.invocation(
                command: command, args: args, stateDirectory: "/paired/team"
            ))
        }
    }
}
