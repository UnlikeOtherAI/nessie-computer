import XCTest

/// What the menu says while the update helper needs the owner, and that it
/// never hides a running team behind the helper's state.
final class ComputerMenuUpdatesTests: XCTestCase {
    private let reason = "Operation not permitted"

    func testARefusedRegistrationShowsItsReasonAndOpensTheWindow() {
        for language in NativeLanguage.allCases {
            let refused = ComputerMenuModel(teams: [], updates: .registrationFailed(reason: reason), language: language)
            let line = Word.needsYouUpdatesCantStart(reason: reason).text(in: language)
            XCTAssertEqual(refused.needsYou?.title, line)
            XCTAssertTrue(line.hasSuffix(reason), "\(language): the reason is macOS's own")
            XCTAssertEqual(refused.needsYou?.target, ConsoleTarget(), "the strip there has Try again")
            XCTAssertEqual(refused.needsYou?.opensLoginItems, false)
            XCTAssertEqual(refused.icon, .needsYou)
            XCTAssertFalse(Word.updatesRegistrationRefused.text(in: language).isEmpty)
        }
        let english = ComputerMenuModel(
            teams: [], updates: .registrationFailed(reason: reason), language: .britishEnglish
        )
        XCTAssertEqual(english.needsYou?.title, "Needs you: updates can’t start — Operation not permitted")
        XCTAssertEqual(english.status, "No team connected", "true here: no team is on this Mac")
    }

    /// 9 November: the helper's installed runtime refused `describe`, so the
    /// app could read no team, while a daemon another process started served
    /// the team. The menu said "No team connected".
    func testATeamRunningElsewhereIsNeverNoTeamConnected() {
        for updates in [nil, ComputerUpdateAttention.stuck, .needsApproval, .registrationFailed(reason: reason)] {
            for language in NativeLanguage.allCases {
                let live = ComputerMenuModel(
                    teams: [], unreadableTeams: 1, unreadableRunning: 1, updates: updates, language: language
                )
                XCTAssertNotEqual(live.status, Word.statusNoTeam.text(in: language))
                let working = Word.statusWorking(working: 1, paused: 0, notConnected: 0)
                XCTAssertEqual(live.status, working.text(in: language))
                XCTAssertNotEqual(live.icon, .idle)
            }
        }
        let refused = ComputerMenuModel(
            teams: [], unreadableTeams: 1, unreadableRunning: 1, updates: .registrationFailed(reason: reason),
            language: .britishEnglish
        )
        XCTAssertEqual(refused.status, "Working for 1 team")
        XCTAssertEqual(refused.needsYouItems.first?.title, "Needs you: updates can’t start — Operation not permitted")
        XCTAssertEqual(ComputerMenuModel(teams: [], unreadableTeams: 1, unreadableRunning: 1).icon, .needsYou,
                       "its pairing still can't be read")
    }

    func testAPairingThatCantBeReadIsStillATeam() {
        for updates in [nil, ComputerUpdateAttention.needsApproval, .registrationFailed(reason: reason)] {
            let stopped = ComputerMenuModel(teams: [], unreadableTeams: 1, updates: updates, language: .britishEnglish)
            XCTAssertEqual(stopped.status, "Not connected — open Nessie Computer")
            let missing = ComputerMenuModel(
                teams: [], runtimeMissing: true, updates: updates, language: .britishEnglish
            )
            XCTAssertEqual(missing.status, "Not connected — open Nessie Computer")
        }
    }

    func testAWorkingTeamOutranksStuckUpdates() {
        let working = TeamSnapshot(executorId: "a", label: "Sales · Acme", daemon: .running)
        let stuck = ComputerMenuModel(teams: [working], updates: .stuck, language: .britishEnglish)
        XCTAssertEqual(stuck.status, "Working for 1 team")
        XCTAssertEqual(stuck.needsYou?.title, "Needs you: updates are stuck — open Nessie Computer")
        let stopped = TeamSnapshot(executorId: "a", label: "Sales · Acme", daemon: .stopped)
        XCTAssertEqual(ComputerMenuModel(teams: [stopped], updates: .stuck, language: .britishEnglish).status,
                       "Updates are stuck — teams can’t start")
    }
}
