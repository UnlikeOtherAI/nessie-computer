import ServiceManagement
import XCTest

/// The helper registered by an older app keeps running until it restarts.
/// These model the Mac stuck on 8 November: 0.9.0 installed, a newer app,
/// a helper whose status never answers in time.
final class ComputerUpdateRecoveryTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_794_200_000)

    private func restart(
        enabled: Bool = true, failures: Int = 0, installed: String? = "0.9.0", phase: String? = "waiting",
        app: String? = "1.0.16", restarts: ComputerUpdateRestartRecord? = nil, now: Date? = nil
    ) -> Bool {
        let answer = installed.flatMap { version in phase.map { (installedVersion: version, phase: $0) } }
        return ComputerUpdateRecovery.shouldRestart(
            enabled: enabled, failures: failures, answer: answer, applicationVersion: app, restarts: restarts,
            now: now ?? start
        )
    }

    private func attention(
        _ registration: SMAppService.Status?, failures: Int = 0, reregistered: Bool = false, factoryReady: Bool = true,
        refused: String? = nil
    ) -> ComputerUpdateAttention? {
        ComputerUpdateRecovery.attention(
            registration: registration, factoryReady: factoryReady, failures: failures, reregistered: reregistered,
            registrationFailure: refused
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

    /// Every SMAppService status, with and without a refused `register()`.
    func testARefusedRegistrationAsksToTryAgainOnlyWhileNothingIsRegistered() {
        let reason = "Operation not permitted"
        for status in [SMAppService.Status.notRegistered, .notFound] {
            XCTAssertEqual(attention(status, refused: reason), .registrationFailed(reason: reason))
            XCTAssertEqual(attention(status, failures: 4, reregistered: true, refused: reason),
                           .registrationFailed(reason: reason))
            XCTAssertNil(attention(status), "not attempted yet: setup has its own state")
        }
        XCTAssertEqual(attention(.requiresApproval, refused: reason), .needsApproval)
        XCTAssertNil(attention(.enabled, refused: reason), "registered since: an old refusal no longer holds")
        XCTAssertEqual(attention(.enabled, failures: 2, refused: reason), .stuck)
        XCTAssertNil(attention(nil, refused: reason), "a development build manages no helper")
    }

    func testANewerAppRestartsAnOlderOrStuckHelper() {
        XCTAssertFalse(restart(installed: nil, phase: nil), "one slow answer is not stuck")
        XCTAssertTrue(restart(failures: 2, installed: nil, phase: nil))
        XCTAssertTrue(restart(installed: "0.9.0", phase: "waiting"))
        XCTAssertTrue(restart(installed: "1.0.15", phase: "idle"))
        XCTAssertFalse(restart(installed: "1.0.16", phase: "idle"), "same version")
        XCTAssertFalse(restart(installed: "1.0.17", phase: "idle"), "never toward an older app")
        XCTAssertFalse(restart(enabled: false, failures: 3))
        XCTAssertFalse(restart(app: nil))
    }

    /// 9 November: one restart per version left a helper that could not swap
    /// the runtime at that moment stuck for good. It is restarted again, later
    /// each time, and never in a tight loop.
    func testARestartThatDidNotHelpIsRetriedLaterEachTime() {
        var record = ComputerUpdateRestartRecord(version: "1.0.16")
        var now = start
        for count in 1...8 {
            XCTAssertTrue(restart(failures: 2, restarts: record, now: now), "restart \(count) comes by itself")
            record = record.restarted(at: now)
            let delay = ComputerUpdateRecovery.restartDelay(after: count)
            XCTAssertFalse(restart(failures: 2, restarts: record, now: now.addingTimeInterval(delay - 1)))
            XCTAssertFalse(restart(installed: "0.9.0", restarts: record, now: now.addingTimeInterval(delay - 1)))
            now = now.addingTimeInterval(delay)
        }
        XCTAssertEqual((1...7).map { ComputerUpdateRecovery.restartDelay(after: $0) },
                       [900, 1_800, 3_600, 7_200, 14_400, 14_400, 14_400])
        XCTAssertTrue(restart(failures: 2, app: "1.0.17", restarts: record, now: start),
                      "a new app version restarts at once")
        XCTAssertFalse(restart(installed: "1.0.16", phase: "idle", restarts: record, now: now),
                       "a helper running this app's runtime is left alone")
        let saved = ComputerUpdateRestartRecord(stored: record.stored, version: "1.0.16")
        XCTAssertEqual(saved, record)
        XCTAssertEqual(ComputerUpdateRestartRecord(stored: record.stored, version: "1.0.17"),
                       ComputerUpdateRestartRecord(version: "1.0.17"))
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
            let waiting = ComputerMenuModel(teams: [], updates: .needsApproval, language: language)
            XCTAssertEqual(waiting.needsYou?.title, Word.needsYouUpdatesApproval.text(in: language))
            XCTAssertEqual(waiting.needsYou?.opensLoginItems, true)
            XCTAssertEqual(waiting.icon, .needsYou)
            XCTAssertNotEqual(waiting.status, Word.statusUpdatesStuck.text(in: language), "approval is not stuck")
        }
        let english = ComputerMenuModel(teams: [], updates: .needsApproval, language: .britishEnglish)
        XCTAssertEqual(english.needsYou?.title,
                       "Needs you: allow Nessie Computer in System Settings to finish updating")
        // With another thing waiting, the one line opens the window, whose Overview has the button.
        let two = ComputerMenuModel(
            teams: [], runtimeMissing: true, updates: .needsApproval, language: .britishEnglish
        )
        XCTAssertEqual(two.needsYouItems.first?.opensLoginItems, true)
        XCTAssertEqual(two.needsYou?.opensLoginItems, false)
        XCTAssertEqual(ComputerMenuModel(teams: [], updates: .stuck).needsYou?.opensLoginItems, false)
    }

    func testMenuSaysUpdatesAreStuckInsteadOfNoTeam() {
        for language in NativeLanguage.allCases {
            let stuck = ComputerMenuModel(teams: [], updates: .stuck, language: language)
            XCTAssertEqual(stuck.status, Word.statusUpdatesStuck.text(in: language))
            XCTAssertNotEqual(stuck.status, Word.statusNoTeam.text(in: language))
            XCTAssertEqual(stuck.needsYou?.title, Word.needsYouUpdatesStuck.text(in: language))
            XCTAssertEqual(stuck.needsYou?.target, ConsoleTarget())
            XCTAssertEqual(stuck.icon, .needsYou)
        }
        let english = ComputerMenuModel(teams: [], updates: .stuck, language: .britishEnglish)
        XCTAssertEqual(english.status, "Updates are stuck — teams can’t start")
        XCTAssertEqual(ComputerMenuModel(teams: [], language: .britishEnglish).status, "No team connected")
    }
}
