import ServiceManagement
import XCTest

/// 9 November, 1.0.18: the automatic restart unregistered the helper and macOS
/// refused the new `register()` ("Operation not permitted"). The refusal was
/// swallowed, the status stayed `notRegistered`, launchd ran no helper and the
/// app never registered again.
final class ComputerUpdateRegistrationTests: XCTestCase {
    private let refused = NSError(domain: "SMAppServiceErrorDomain", code: 1, userInfo: [
        NSLocalizedFailureReasonErrorKey: "Operation not permitted"
    ])

    func testNoRegistrationIsRegisteredABoundedNumberOfTimesByItself() {
        for status in [SMAppService.Status.notRegistered, .notFound] {
            XCTAssertTrue(ComputerUpdateRegistration.shouldRegister(status: status, requested: false, attempts: 0))
            XCTAssertTrue(ComputerUpdateRegistration.shouldRegister(status: status, requested: false, attempts: 1),
                          "a refused registration is made again")
            XCTAssertFalse(ComputerUpdateRegistration.shouldRegister(status: status, requested: false, attempts: 2),
                           "never a loop")
            XCTAssertTrue(ComputerUpdateRegistration.shouldRegister(status: status, requested: true, attempts: 9),
                          "the owner's Try again is never limited")
        }
    }

    func testApprovalAndEnabledServicesAreNotRegisteredAgain() {
        for status in [SMAppService.Status.enabled, .requiresApproval] {
            for attempts in [0, 2] {
                XCTAssertFalse(ComputerUpdateRegistration.shouldRegister(
                    status: status, requested: false, attempts: attempts
                ))
                XCTAssertFalse(ComputerUpdateRegistration.shouldRegister(
                    status: status, requested: true, attempts: attempts
                ))
            }
        }
    }

    func testAFailedRegisterKeepsMacOSsReasonForEveryStatus() {
        let fallback = Word.updatesRegistrationRefused.text(in: .britishEnglish)
        for status in [SMAppService.Status.notRegistered, .notFound] {
            XCTAssertEqual(ComputerUpdateRegistration.failure(after: refused, status: status, fallback: fallback),
                           "Operation not permitted")
            XCTAssertEqual(ComputerUpdateRegistration.failure(after: nil, status: status, fallback: fallback),
                           fallback, "returning without a registration is a refusal too")
        }
        // A daemon awaiting approval can report launch denial; approval is its door.
        XCTAssertNil(ComputerUpdateRegistration.failure(after: refused, status: .requiresApproval, fallback: fallback))
        XCTAssertNil(ComputerUpdateRegistration.failure(after: nil, status: .enabled, fallback: fallback))
        XCTAssertNil(ComputerUpdateRegistration.failure(after: refused, status: .enabled, fallback: fallback))
    }

    func testTheReasonIsShortWordsNeverACode() {
        let fallback = "macOS didn’t register the background helper."
        let codeOnly = NSError(domain: "SMAppServiceErrorDomain", code: 1)
        XCTAssertEqual(ComputerUpdateRegistration.reason(codeOnly, fallback: fallback), fallback)
        let described = NSError(domain: "SMAppServiceErrorDomain", code: 3, userInfo: [
            NSLocalizedDescriptionKey: "  Invalid code signature  "
        ])
        XCTAssertEqual(ComputerUpdateRegistration.reason(described, fallback: fallback), "Invalid code signature")
        let long = NSError(domain: "SMAppServiceErrorDomain", code: 1, userInfo: [
            NSLocalizedFailureReasonErrorKey: String(repeating: "a", count: 300)
        ])
        XCTAssertEqual(ComputerUpdateRegistration.reason(long, fallback: fallback).count, 120)
    }

    func testTheRecordBelongsToOneAppVersion() {
        let live = ComputerUpdateRegistrationRecord(version: "1.0.18", attempts: 1, failure: "Operation not permitted")
        XCTAssertEqual(ComputerUpdateRegistrationRecord(stored: live.stored, version: "1.0.18"), live)
        XCTAssertEqual(ComputerUpdateRegistrationRecord(stored: live.stored, version: "1.0.19"),
                       ComputerUpdateRegistrationRecord(version: "1.0.19"), "a newer app registers again")
        XCTAssertEqual(ComputerUpdateRegistrationRecord(stored: nil, version: "1.0.19").attempts, 0)
        let cleared = ComputerUpdateRegistrationRecord(version: "1.0.19", attempts: 2)
        XCTAssertNil(ComputerUpdateRegistrationRecord(stored: cleared.stored, version: "1.0.19").failure)
    }

    /// The live sequence: restart refused, one more automatic attempt, then the
    /// window and menu say why, with Try again.
    func testTheNinthOfNovemberRefusalShowsItsReasonWithTryAgain() {
        var record = ComputerUpdateRegistrationRecord(version: "1.0.19", attempts: 1)
        record.failure = ComputerUpdateRegistration.failure(after: refused, status: .notRegistered, fallback: "x")
        XCTAssertTrue(ComputerUpdateRegistration.shouldRegister(
            status: .notRegistered, requested: false, attempts: record.attempts
        ))
        record.attempts += 1
        XCTAssertFalse(ComputerUpdateRegistration.shouldRegister(
            status: .notRegistered, requested: false, attempts: record.attempts
        ))
        XCTAssertEqual(ComputerUpdateRecovery.attention(
            registration: .notRegistered, factoryReady: true, failures: 0, reregistered: true,
            registrationFailure: record.failure
        ), .registrationFailed(reason: "Operation not permitted"))
    }
}
