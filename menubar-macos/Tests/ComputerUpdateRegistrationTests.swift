import ServiceManagement
import XCTest

final class ComputerUpdateRegistrationTests: XCTestCase {
    func testFirstLaunchRegistersANewBackgroundTaskRecord() {
        for status in [SMAppService.Status.notFound, .notRegistered] {
            XCTAssertTrue(ComputerUpdateRegistration.shouldRegister(status: status, attempted: false, requested: false))
            XCTAssertFalse(ComputerUpdateRegistration.shouldRegister(status: status, attempted: true, requested: false))
            XCTAssertTrue(ComputerUpdateRegistration.shouldRegister(status: status, attempted: true, requested: true))
        }
    }

    func testApprovalAndEnabledServicesAreNotRegisteredAgain() {
        for status in [SMAppService.Status.enabled, .requiresApproval] {
            XCTAssertFalse(ComputerUpdateRegistration.shouldRegister(
                status: status, attempted: false, requested: false
            ))
            XCTAssertFalse(ComputerUpdateRegistration.shouldRegister(status: status, attempted: true, requested: true))
        }
    }
}
