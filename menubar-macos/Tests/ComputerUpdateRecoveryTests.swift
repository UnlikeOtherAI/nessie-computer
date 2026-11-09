import ServiceManagement
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

    private func attention(
        _ registration: SMAppService.Status?, failures: Int = 0, reregistered: Bool = false, factoryReady: Bool = true
    ) -> ComputerUpdateAttention? {
        ComputerUpdateRecovery.attention(
            registration: registration, factoryReady: factoryReady, failures: failures, reregistered: reregistered
        )
    }

    func testAnUnansweredHelperIsStuckOnlyAfterTwoProbesInARow() {
        XCTAssertNil(attention(.enabled, failures: 1))
        XCTAssertEqual(attention(.enabled, failures: 2), .stuck)
        XCTAssertNil(attention(.enabled, failures: 5, factoryReady: false), "first setup has its own state")
        XCTAssertNil(attention(.notRegistered, failures: 5), "setup has its own state")
        XCTAssertNil(attention(nil, failures: 5), "a development build manages no helper")
    }

    /// 8 November, 1.0.16: the app re-registered its helper and no helper ran for
    /// ten minutes while the app said only that updates were stuck.
    func testAHelperWaitingForApprovalAsksForItInsteadOfARestart() {
        XCTAssertEqual(attention(.requiresApproval), .needsApproval, "no probe has to fail first")
        XCTAssertEqual(attention(.requiresApproval, failures: 3, reregistered: true), .needsApproval)
        XCTAssertNil(attention(.enabled, failures: 1, reregistered: true), "it gets a moment to start")
        XCTAssertEqual(attention(.enabled, failures: 2, reregistered: true), .needsApproval,
                       "silent since this app re-registered it")
        XCTAssertEqual(attention(.enabled, failures: 2, reregistered: true, factoryReady: false), .needsApproval)
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

    func testMenuAsksForApprovalAndItsLineOpensLoginItems() {
        for language in NativeLanguage.allCases {
            let waiting = ComputerMenuModel(teams: [], updatesNeedApproval: true, language: language)
            XCTAssertEqual(waiting.needsYou?.title, Word.needsYouUpdatesApproval.text(in: language))
            XCTAssertEqual(waiting.needsYou?.opensLoginItems, true)
            XCTAssertEqual(waiting.icon, .needsYou)
            XCTAssertNotEqual(waiting.status, Word.statusUpdatesStuck.text(in: language), "approval is not stuck")
        }
        let english = ComputerMenuModel(teams: [], updatesNeedApproval: true, language: .britishEnglish)
        XCTAssertEqual(english.needsYou?.title,
                       "Needs you: allow Nessie Computer in System Settings to finish updating")
        // With another thing waiting, the one line opens the window, whose Overview has the button.
        let two = ComputerMenuModel(
            teams: [], runtimeMissing: true, updatesNeedApproval: true, language: .britishEnglish
        )
        XCTAssertEqual(two.needsYouItems.first?.opensLoginItems, true)
        XCTAssertEqual(two.needsYou?.opensLoginItems, false)
        XCTAssertEqual(ComputerMenuModel(teams: [], updatesStuck: true).needsYou?.opensLoginItems, false)
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
