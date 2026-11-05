import XCTest

final class RestartBackoffTests: XCTestCase {
    func testAConnectionThatKeepsStoppingWaitsLongerEachTimeUpToFiveMinutes() {
        let first = RestartBackoff.waits(previous: nil, ran: 1)
        XCTAssertEqual(first.wait, 5)
        XCTAssertEqual(first.next, 10)
        let second = RestartBackoff.waits(previous: first.next, ran: 1)
        XCTAssertEqual(second.wait, 10)
        XCTAssertEqual(second.next, 20)
        let longest = RestartBackoff.waits(previous: 240, ran: 1)
        XCTAssertEqual(longest.wait, 240)
        XCTAssertEqual(longest.next, 300)
        XCTAssertEqual(RestartBackoff.waits(previous: 300, ran: 1).wait, 300)
    }

    func testAConnectionThatStayedUpForTheLongestWaitStartsOver() {
        let waits = RestartBackoff.waits(previous: 300, ran: 300)
        XCTAssertEqual(waits.wait, 5)
        XCTAssertEqual(waits.next, 10)
    }

    func testARestartIsDueOnlyAfterItsWaitAndFiresOnce() {
        let stopped = Date(timeIntervalSince1970: 1_000)
        var schedule = RestartSchedule()
        XCTAssertFalse(schedule.takeDue(now: stopped))
        schedule.schedule(ran: 1, now: stopped)
        XCTAssertEqual(schedule.dueAt, stopped.addingTimeInterval(5))
        XCTAssertFalse(schedule.takeDue(now: stopped.addingTimeInterval(4)))
        XCTAssertTrue(schedule.takeDue(now: stopped.addingTimeInterval(5)))
        XCTAssertFalse(schedule.takeDue(now: stopped.addingTimeInterval(6)))
    }

    func testRepeatedStopsWaitLongerUntilAPersonStopsTheConnection() {
        let stopped = Date(timeIntervalSince1970: 1_000)
        var schedule = RestartSchedule()
        schedule.schedule(ran: 1, now: stopped)
        schedule.schedule(ran: 1, now: stopped)
        XCTAssertEqual(schedule.dueAt, stopped.addingTimeInterval(10))
        schedule.cancel()
        XCTAssertNil(schedule.dueAt)
        schedule.schedule(ran: 1, now: stopped)
        XCTAssertEqual(schedule.dueAt, stopped.addingTimeInterval(5))
    }
}
