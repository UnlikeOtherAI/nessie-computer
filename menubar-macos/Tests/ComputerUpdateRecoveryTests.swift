import XCTest

/// The helper registered by an older app keeps running until it restarts.
/// These model the Mac stuck on 8 November: 0.9.0 installed, a newer app,
/// a helper whose status never answers in time.
final class ComputerUpdateRecoveryTests: XCTestCase {
    private func restart(
        enabled: Bool = true, failures: Int = 0, installed: String? = "0.9.0", phase: String? = "waiting",
        app: String? = "1.0.16", restartedFor: String? = nil
    ) -> Bool {
        let answer = installed.flatMap { version in phase.map { (installedVersion: version, phase: $0) } }
        return ComputerUpdateRecovery.shouldRestart(
            enabled: enabled, failures: failures, answer: answer, applicationVersion: app, restartedFor: restartedFor
        )
    }

    func testAnUnansweredHelperIsStuckOnlyAfterTwoProbesInARow() {
        XCTAssertFalse(ComputerUpdateRecovery.stuck(enabled: true, failures: 1))
        XCTAssertTrue(ComputerUpdateRecovery.stuck(enabled: true, failures: 2))
        XCTAssertFalse(ComputerUpdateRecovery.stuck(enabled: false, failures: 5), "setup has its own state")
    }

    func testANewerAppRestartsAnOlderOrStuckHelperOncePerVersion() {
        XCTAssertFalse(restart(installed: nil, phase: nil), "one slow answer is not stuck")
        XCTAssertTrue(restart(failures: 2, installed: nil, phase: nil))
        XCTAssertTrue(restart(installed: "0.9.0", phase: "waiting"))
        XCTAssertTrue(restart(installed: "1.0.15", phase: "idle"))
        XCTAssertFalse(restart(installed: "1.0.16", phase: "idle"), "same version")
        XCTAssertFalse(restart(installed: "1.0.17", phase: "idle"), "never toward an older app")
        XCTAssertFalse(restart(failures: 2, restartedFor: "1.0.16"), "no restart loop")
        XCTAssertTrue(restart(failures: 2, app: "1.0.17", restartedFor: "1.0.16"), "the next version may")
        XCTAssertFalse(restart(enabled: false, failures: 3))
        XCTAssertFalse(restart(app: nil))
    }

    func testAStartedReplacementIsNeverInterrupted() {
        XCTAssertFalse(restart(phase: "installing"))
        XCTAssertFalse(restart(phase: "restarting"))
    }

    func testOnlyNumericVersionsCompare() {
        XCTAssertTrue(ComputerUpdateRecovery.isNewer("1.0.10", than: "1.0.9"))
        XCTAssertTrue(ComputerUpdateRecovery.isNewer("1.0.0", than: "0.0.65000"))
        XCTAssertFalse(ComputerUpdateRecovery.isNewer("1.0", than: "0.9.0"))
        XCTAssertFalse(ComputerUpdateRecovery.isNewer("1.0.16", than: ""))
        XCTAssertFalse(ComputerUpdateRecovery.isNewer("1.0.16-beta", than: "1.0.15"))
    }

    func testTheAppReadsItsOwnRuntimeVersion() throws {
        let root = "/Applications/Nessie Executor.app/Contents/Resources/executor-runtime"
        let runtime = PackagedRuntime(root: URL(fileURLWithPath: root))
        XCTAssertEqual(runtime.executorVersion { _ in Data(#"{"executorVersion":"1.0.16"}"#.utf8) }, "1.0.16")
        XCTAssertNil(runtime.executorVersion { _ in nil })
        XCTAssertNil(runtime.executorVersion { _ in Data("not json".utf8) })
    }

    func testMenuSaysUpdatesAreStuckInsteadOfNoTeam() {
        for language in NativeLanguage.allCases {
            let stuck = ComputerMenuModel(teams: [], updatesStuck: true, language: language)
            XCTAssertEqual(stuck.status, Word.statusUpdatesStuck.text(in: language))
            XCTAssertNotEqual(stuck.status, Word.statusNoTeam.text(in: language))
            XCTAssertEqual(stuck.needsYou?.title, Word.needsYouUpdatesStuck.text(in: language))
            XCTAssertEqual(stuck.needsYou?.target, ConsoleTarget())
            XCTAssertEqual(stuck.icon, .needsYou)
        }
        let english = ComputerMenuModel(teams: [], updatesStuck: true, language: .britishEnglish)
        XCTAssertEqual(english.status, "Updates are stuck — teams can’t start")
        XCTAssertEqual(ComputerMenuModel(teams: [], language: .britishEnglish).status, "No team connected")
    }
}
