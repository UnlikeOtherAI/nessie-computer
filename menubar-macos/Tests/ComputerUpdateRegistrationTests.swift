import ServiceManagement
import XCTest

/// 9 November, 1.0.18 and 1.0.19: the automatic restart unregistered the helper
/// and macOS refused the new `register()` ("Operation not permitted"). The status
/// stayed `notRegistered`, launchd ran no helper, and the app stopped asking
/// after two attempts. It now keeps asking, later each time, without a click.
final class ComputerUpdateRegistrationTests: XCTestCase {
    private let refused = NSError(domain: "SMAppServiceErrorDomain", code: 1, userInfo: [
        NSLocalizedFailureReasonErrorKey: "Operation not permitted"
    ])

    private let start = Date(timeIntervalSince1970: 1_794_200_000)

    private func record(refusals: Int, lastAttempt: Date?) -> ComputerUpdateRegistrationRecord {
        ComputerUpdateRegistrationRecord(version: "1.0.20", attempts: refusals, failure: "x", lastAttempt: lastAttempt)
    }

    /// A refused helper is asked for again by itself, later each time, and never given up on.
    func testAMissingRegistrationIsRegisteredAgainForeverWithBackoff() {
        let fresh = ComputerUpdateRegistrationRecord(version: "1.0.20")
        for status in [SMAppService.Status.notRegistered, .notFound] {
            XCTAssertTrue(ComputerUpdateRegistration.shouldRegister(
                status: status, requested: false, record: fresh, now: start
            ), "first setup registers at once")
            for refusals in [1, 2, 5, 40] {
                let delay = ComputerUpdateRegistration.retryDelay(after: refusals)
                let last = record(refusals: refusals, lastAttempt: start)
                XCTAssertFalse(ComputerUpdateRegistration.shouldRegister(
                    status: status, requested: false, record: last, now: start.addingTimeInterval(delay - 1)
                ), "waits after \(refusals) refusals")
                XCTAssertTrue(ComputerUpdateRegistration.shouldRegister(
                    status: status, requested: false, record: last, now: start.addingTimeInterval(delay)
                ), "asks again after \(refusals) refusals")
                XCTAssertTrue(ComputerUpdateRegistration.shouldRegister(
                    status: status, requested: true, record: last, now: start
                ), "the owner's Try again never waits")
            }
        }
        XCTAssertEqual((1...8).map { ComputerUpdateRegistration.retryDelay(after: $0) },
                       [15, 30, 60, 120, 240, 480, 900, 900])
        XCTAssertEqual(ComputerUpdateRegistration.retryDelay(after: 1_000), 900, "never longer than 15 minutes")
    }

    func testApprovalAndEnabledServicesAreNotRegisteredAgain() {
        for status in [SMAppService.Status.enabled, .requiresApproval] {
            for refusals in [0, 2] {
                for requested in [false, true] {
                    XCTAssertFalse(ComputerUpdateRegistration.shouldRegister(
                        status: status, requested: requested, record: record(refusals: refusals, lastAttempt: nil),
                        now: start
                    ))
                }
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
        let live = ComputerUpdateRegistrationRecord(
            version: "1.0.18", attempts: 1, failure: "Operation not permitted", lastAttempt: start
        )
        XCTAssertEqual(ComputerUpdateRegistrationRecord(stored: live.stored, version: "1.0.18"), live)
        XCTAssertEqual(ComputerUpdateRegistrationRecord(stored: live.stored, version: "1.0.19"),
                       ComputerUpdateRegistrationRecord(version: "1.0.19"), "a newer app registers again")
        XCTAssertEqual(ComputerUpdateRegistrationRecord(stored: nil, version: "1.0.19").attempts, 0)
        let cleared = ComputerUpdateRegistrationRecord(version: "1.0.19", attempts: 2)
        XCTAssertNil(ComputerUpdateRegistrationRecord(stored: cleared.stored, version: "1.0.19").failure)
    }

    /// 1.0.19's launch registered (accepted), then its restart was refused. The
    /// accepted one no longer counts, and the refusal is retried 15 seconds later.
    func testOnlyRefusalsCountTowardTheBackoff() {
        let launch = ComputerUpdateRegistration.recorded(
            ComputerUpdateRegistrationRecord(version: "1.0.19"), automatic: true, failure: nil, at: start
        )
        XCTAssertEqual(launch.attempts, 0)
        let restart = ComputerUpdateRegistration.recorded(
            launch, automatic: true, failure: "Operation not permitted", at: start
        )
        XCTAssertEqual(restart.attempts, 1)
        XCTAssertEqual(restart.lastAttempt, start)
        XCTAssertTrue(ComputerUpdateRegistration.shouldRegister(
            status: .notRegistered, requested: false, record: restart, now: start.addingTimeInterval(15)
        ))
        let owner = ComputerUpdateRegistration.recorded(
            restart, automatic: false, failure: "Operation not permitted", at: start.addingTimeInterval(5)
        )
        XCTAssertEqual(owner.attempts, 1, "Try again is the owner's, never counted")
        XCTAssertEqual(owner.lastAttempt, start, "and it does not push the next automatic one back")
        let accepted = ComputerUpdateRegistration.recorded(owner, automatic: false, failure: nil, at: start)
        XCTAssertEqual(accepted, ComputerUpdateRegistrationRecord(version: "1.0.19"))
    }

    /// The restart registers only once macOS stops reporting the removed helper.
    func testTheRestartWaitsUntilTheRemovedHelperIsGone() async {
        var answers: [SMAppService.Status] = [.enabled, .enabled, .enabled, .notRegistered]
        var pauses = 0
        let settled = await ComputerUpdateRegistration.settle(
            status: { answers.removeFirst() }, pause: { pauses += 1 }
        )
        XCTAssertTrue(settled)
        XCTAssertEqual(pauses, 3)

        pauses = 0
        let immediate = await ComputerUpdateRegistration.settle(status: { .notFound }, pause: { pauses += 1 })
        XCTAssertTrue(immediate)
        XCTAssertEqual(pauses, 0, "nothing to wait for")

        pauses = 0
        let stuck = await ComputerUpdateRegistration.settle(polls: 5, status: { .enabled }, pause: { pauses += 1 })
        XCTAssertFalse(stuck)
        XCTAssertEqual(pauses, 5, "bounded: it registers anyway and keeps any refusal")
    }

    /// The live sequence: the restart is refused and the window says why while
    /// the app keeps registering again by itself; Try again only hurries it.
    func testARefusalShowsItsReasonWhileTheAppKeepsTrying() {
        var record = ComputerUpdateRegistrationRecord(version: "1.0.19")
        for refusal in 1...12 {
            let now = start.addingTimeInterval(Double(refusal) * 1_000)
            XCTAssertTrue(ComputerUpdateRegistration.shouldRegister(
                status: .notRegistered, requested: false, record: record, now: now
            ), "attempt \(refusal) is made without a click")
            record = ComputerUpdateRegistration.recorded(
                record, automatic: true,
                failure: ComputerUpdateRegistration.failure(after: refused, status: .notRegistered, fallback: "x"),
                at: now
            )
        }
        XCTAssertEqual(ComputerUpdateRecovery.attention(
            registration: .notRegistered, factoryReady: true, failures: 0, reregistered: true,
            registrationFailure: record.failure
        ), .registrationFailed(reason: "Operation not permitted"))
    }
}
