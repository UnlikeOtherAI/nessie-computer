import Foundation
import XCTest

/// Pause persistence across the upgrade: a team an owner stopped in an earlier
/// version must come back paused, never working.
final class LegacyStopPreferenceTests: XCTestCase {
    private func defaults() throws -> (UserDefaults, String) {
        let suite = "executor-run-preference-\(UUID().uuidString)"
        return (try XCTUnwrap(UserDefaults(suiteName: suite)), suite)
    }

    func testAStoppedTeamIsPausedAndARunningOneIsLeftAlone() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        // What the earlier app wrote when a person chose Stop, and Start.
        defaults.set(false, forKey: "executor.connection.running.team-a")
        defaults.set(true, forKey: "executor.connection.running.team-b")
        XCTAssertTrue(LegacyStopPreference.needsPause("team-a", defaults: defaults))
        XCTAssertFalse(LegacyStopPreference.needsPause("team-b", defaults: defaults))
        XCTAssertFalse(LegacyStopPreference.needsPause("team-c", defaults: defaults), "no switch means running")
    }

    /// The switch survives until the pause is saved, so a failed pause is
    /// tried again at the next launch rather than starting agents.
    func testTheSwitchIsForgottenOnlyWhenAskedAndStaysForgotten() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(false, forKey: "executor.connection.running.team-a")
        let reopened = try XCTUnwrap(UserDefaults(suiteName: suite))
        XCTAssertTrue(LegacyStopPreference.needsPause("team-a", defaults: reopened))
        LegacyStopPreference.forget("team-a", defaults: reopened)
        XCTAssertFalse(LegacyStopPreference.needsPause("team-a", defaults: defaults))
        XCTAssertNil(defaults.object(forKey: "executor.connection.running.team-a"))
    }
}
