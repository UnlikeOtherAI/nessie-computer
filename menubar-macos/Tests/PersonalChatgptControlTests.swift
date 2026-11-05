import Foundation
import XCTest

final class PersonalChatgptControlTests: XCTestCase {
    func testPublicOperationKeepsConsentOnStdin() throws {
        let operation: [String: Any] = ["operation": "start", "acknowledgeHostRestriction": false]
        let invocation = try PersonalChatgptControl.invocation(operation: operation, stateDirectory: "/paired/team")
        XCTAssertEqual(invocation.arguments, [
            "personal-chatgpt-local", "--operation-stdin", "--state-dir", "/paired/team"
        ])
        let data = try XCTUnwrap(invocation.standardInput)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body["acknowledgeHostRestriction"] as? Bool, false)
    }

    func testWebViewCannotSupplySecretsPathsOrAuthority() {
        for field in ["stateDirectory", "accessToken", "apiOrigin", "organizationId", "teamId"] {
            XCTAssertThrowsError(try PersonalChatgptControl.invocation(
                operation: ["operation": "status", field: "forged"], stateDirectory: "/paired/team"
            ))
        }
        XCTAssertThrowsError(try PersonalChatgptControl.invocation(
            operation: ["operation": "background-consent", "enabled": true, "expectedRevision": NSNull()],
            stateDirectory: "/paired/team"
        ))
    }
}
