import XCTest

final class ComputerRuntimeHoldsTests: XCTestCase {
    func testSignInAndUpdateKeepIndependentHolds() {
        var holds = ComputerRuntimeHolds()
        XCTAssertTrue(holds.beginPersonalSignIn())
        XCTAssertFalse(holds.beginPersonalSignIn())
        holds.update = true
        holds.endPersonalSignIn()
        XCTAssertTrue(holds.held)
        XCTAssertFalse(holds.beginPersonalSignIn())
        holds.update = false
        XCTAssertFalse(holds.held)
        XCTAssertTrue(holds.beginPersonalSignIn())
        holds.endPersonalSignIn()
        XCTAssertFalse(holds.held)
    }
}
