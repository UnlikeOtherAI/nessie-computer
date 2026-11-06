import Foundation
import XCTest

final class ConnectionRunPreferenceTests: XCTestCase {
    func testStoppedConnectionsStayStoppedWithoutChangingAnotherTeam() throws {
        let suite = "executor-run-preference-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertTrue(ConnectionRunPreference.wanted("team-a", defaults: defaults))
        ConnectionRunPreference.set(false, for: "team-a", defaults: defaults)
        XCTAssertFalse(ConnectionRunPreference.wanted("team-a", defaults: defaults))
        XCTAssertTrue(ConnectionRunPreference.wanted("team-b", defaults: defaults))
        let reopened = try XCTUnwrap(UserDefaults(suiteName: suite))
        XCTAssertFalse(ConnectionRunPreference.wanted("team-a", defaults: reopened))
        ConnectionRunPreference.set(true, for: "team-a", defaults: reopened)
        XCTAssertTrue(ConnectionRunPreference.wanted("team-a", defaults: defaults))
    }
}
