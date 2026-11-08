import XCTest

final class LoginItemCommandTests: XCTestCase {
    func testOnlyTheExactSwitchAndOneWordAreTheCommand() {
        XCTAssertEqual(LoginItemCommand.parse(["app", "--login-item", "status"]), .status)
        XCTAssertEqual(LoginItemCommand.parse(["app", "--login-item", "on"]), .set(true))
        XCTAssertEqual(LoginItemCommand.parse(["app", "--login-item", "off"]), .set(false))
        for arguments in [["app"], ["app", "--login-item"], ["app", "--login-item", "yes"],
                          ["app", "--login-item", "on", "extra"], ["app", "-psn_0_1234"], ["app", "--login-item=on", "x"]] {
            XCTAssertNil(LoginItemCommand.parse(arguments), arguments.joined(separator: " "))
        }
    }

    func testTheAnswerIsOneJSONLineTheCommandLineReads() throws {
        let on = try JSONSerialization.jsonObject(with: Data(LoginItemCommand.answer(enabled: true).utf8)) as? [String: Bool]
        XCTAssertEqual(on, ["enabled": true])
        let refused = try JSONSerialization.jsonObject(
            with: Data(LoginItemCommand.answer(refusal: "needsApproval").utf8)
        ) as? [String: String]
        XCTAssertEqual(refused, ["error": "needsApproval"])
    }
}
