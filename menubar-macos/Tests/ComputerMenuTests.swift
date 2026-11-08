import XCTest

/// The menu bar menu of contract §3.1, decided without AppKit.
final class ComputerMenuTests: XCTestCase {
    private func team(
        _ id: String,
        _ label: String,
        daemon: DaemonState = .running,
        connecting: Bool = false,
        paused: Bool = false,
        failure: TeamFailure? = nil,
        retrying: Bool = false,
        requests: Int = 0
    ) -> TeamSnapshot {
        TeamSnapshot(
            executorId: id, label: label, daemon: daemon, connecting: connecting, paused: paused,
            failure: failure, retrying: retrying, pendingProgramRequests: requests
        )
    }

    private func menu(_ teams: [TeamSnapshot], unreadable: Int = 0, runtimeMissing: Bool = false) -> ComputerMenuModel {
        ComputerMenuModel(
            teams: teams, unreadableTeams: unreadable, runtimeMissing: runtimeMissing, language: .britishEnglish
        )
    }

    private let fenced = TeamFailure(classifying: "Executor connection is fenced.")

    // MARK: - Status sentence

    func testTheStatusSpeaksAboutEveryTeamAtOnce() {
        XCTAssertEqual(menu([]).status, "No team connected")
        XCTAssertEqual(menu([team("a", "Sales · Acme")]).status, "Working for 1 team")
        XCTAssertEqual(menu([team("a", "Sales · Acme"), team("b", "Ops · Acme")]).status, "Working for 2 teams")
        XCTAssertEqual(
            menu([team("a", "Sales · Acme"), team("b", "Ops · Acme", paused: true)]).status,
            "Working for 1 team · 1 paused"
        )
        XCTAssertEqual(
            menu([team("a", "A"), team("b", "B", daemon: .stopped), team("c", "C", paused: true)]).status,
            "Working for 1 team · 1 paused · 1 not connected"
        )
        XCTAssertEqual(menu([team("a", "A", paused: true), team("b", "B", paused: true)]).status, "Paused")
        XCTAssertEqual(menu([team("a", "A", daemon: .stopped, connecting: true)]).status, "Connecting…")
        XCTAssertEqual(
            menu([team("a", "A", daemon: .stopped)]).status, "Not connected — open Nessie Computer"
        )
    }

    // MARK: - Pause persistence

    /// A paused team is paused, not stopped: its daemon keeps running, so the
    /// menu must not call it working, and a paused team whose daemon is
    /// restarting is still paused.
    func testAPausedTeamIsNeverWorkingAndNeverStopped() {
        for daemon in [DaemonState.running, .stopped, .stopping] {
            let paused = team("a", "A", daemon: daemon, connecting: daemon == .stopped, paused: true)
            XCTAssertEqual(paused.activity, .paused, "\(daemon)")
            XCTAssertEqual(menu([paused]).status, "Paused")
            XCTAssertEqual(menu([paused]).icon, .idle, "everything paused is idle")
            XCTAssertEqual(menu([paused]).quitTitle, "Quit Nessie Computer", "no agent is working")
        }
    }

    // MARK: - Icon rules

    /// Starting, stopping and connecting are never amber; working is working.
    func testInFlightStatesAreNeverAmber() {
        XCTAssertEqual(menu([]).icon, .idle)
        XCTAssertEqual(menu([team("a", "A")]).icon, .working)
        XCTAssertEqual(menu([team("a", "A", daemon: .stopped, connecting: true)]).icon, .idle)
        XCTAssertEqual(menu([team("a", "A", daemon: .stopping)]).icon, .idle)
        XCTAssertEqual(menu([team("a", "A", daemon: .stopped)]).icon, .idle, "stopped without a reason")
        XCTAssertNil(menu([team("a", "A", daemon: .stopping)]).needsYou)
    }

    /// A failure is the owner's only once nothing is about to retry it.
    func testAFailureNeedsTheOwnerOnlyWhenNothingRetriesIt() {
        let retried = team("a", "Sales · Acme", daemon: .stopped, failure: fenced, retrying: true)
        XCTAssertEqual(menu([retried]).icon, .idle)
        let stuck = team("a", "Sales · Acme", daemon: .stopped, failure: fenced)
        XCTAssertEqual(menu([stuck]).icon, .needsYou)
        XCTAssertEqual(menu([stuck]).needsYou?.title, "Needs you: Sales · Acme — not connected")
        XCTAssertEqual(menu([stuck]).needsYou?.target, ConsoleTarget(executorId: "a"))
        let recovered = team("a", "Sales · Acme", failure: fenced)
        XCTAssertNil(menu([recovered]).needsYou, "a running daemon is not stopped by an old failure")
    }

    /// A program request is the one thing that must reach the owner quickly.
    func testAProgramRequestNeedsTheOwnerAndOpensTheWindow() {
        let model = menu([team("a", "Sales · Acme", requests: 1), team("b", "Ops · Acme")])
        XCTAssertEqual(model.icon, .needsYou)
        XCTAssertEqual(model.needsYou?.title, "Needs you: Sales · Acme — a program asks to run")
        XCTAssertEqual(model.needsYou?.target, ConsoleTarget(executorId: "a"))
        XCTAssertEqual(
            menu([team("a", "Sales · Acme", requests: 3)]).needsYou?.title,
            "Needs you: Sales · Acme — 3 programs ask to run"
        )
        XCTAssertEqual(model.toolTip, "Working for 2 teams\nNeeds you: Sales · Acme — a program asks to run")
    }

    func testSeveralThingsBecomeOneLine() {
        let model = menu(
            [team("a", "A", requests: 1), team("b", "B", daemon: .stopped, failure: fenced)], runtimeMissing: true
        )
        XCTAssertEqual(model.needsYouItems.count, 3)
        XCTAssertEqual(model.needsYouItems.first?.title, "Needs you: reinstall Nessie Computer")
        XCTAssertEqual(model.needsYou?.title, "Needs you: 3 things — open Nessie Computer")
        XCTAssertEqual(model.needsYou?.target, ConsoleTarget())
        XCTAssertEqual(menu([], unreadable: 1).needsYou?.title, "Needs you: a team on this Mac can’t be read")
    }

    /// Nessie names a team again only after its owner confirms this computer
    /// there: the line says so and opens that team's computer page. A team
    /// folder this Mac cannot read keeps its own line.
    func testAConfirmationOpensThatComputersPageAndAReadFailureKeepsItsOwnLine() {
        let model = ComputerMenuModel(
            teams: [team("a", "Team name not available yet")], confirmationTeams: ["a"], language: .britishEnglish
        )
        XCTAssertEqual(model.needsYou, NeedsYouItem(
            title: "Needs you: confirm this computer in Nessie",
            target: ConsoleTarget(executorId: "a"),
            confirmExecutorId: "a"
        ))
        let both = ComputerMenuModel(
            teams: [team("a", "A")], unreadableTeams: 1, confirmationTeams: ["a"], language: .britishEnglish
        )
        XCTAssertEqual(both.needsYouItems.map(\.title), [
            "Needs you: a team on this Mac can’t be read", "Needs you: confirm this computer in Nessie"
        ])
    }

    // MARK: - Pause and Resume lines

    func testOneTeamGetsOnePauseOrResumeLine() {
        XCTAssertEqual(menu([]).pauseMenu, .unavailable(title: "Pause"))
        XCTAssertEqual(
            menu([team("a", "A")]).pauseMenu,
            .single(PauseMenu.Line(title: "Pause", executorId: "a", checked: false, pause: true))
        )
        XCTAssertEqual(
            menu([team("a", "A", paused: true)]).pauseMenu,
            .single(PauseMenu.Line(title: "Resume", executorId: "a", checked: false, pause: false))
        )
    }

    func testSeveralTeamsGetAllTeamsThenOneCheckedLineEach() {
        let model = menu([team("a", "Sales · Acme", paused: true), team("b", "Ops · Acme")])
        XCTAssertEqual(model.pauseMenu, .submenu(title: "Pause", lines: [
            PauseMenu.Line(title: "All teams", executorId: nil, checked: false, pause: true),
            PauseMenu.Line(title: "Sales · Acme", executorId: "a", checked: true, pause: false),
            PauseMenu.Line(title: "Ops · Acme", executorId: "b", checked: false, pause: true)
        ]))
        let allPaused = menu([team("a", "A", paused: true), team("b", "B", paused: true)])
        guard case let .submenu(title, lines) = allPaused.pauseMenu else { return XCTFail("a submenu") }
        XCTAssertEqual(title, "Resume")
        XCTAssertEqual(lines[0], PauseMenu.Line(title: "All teams", executorId: nil, checked: true, pause: false))
    }

    // MARK: - Quit

    /// Quitting stops every daemon this app supervises, so while agents work it says so.
    func testQuitSaysWhatItDoesToWorkingAgents() {
        XCTAssertEqual(menu([team("a", "A")]).quitTitle, "Quit Nessie Computer — agents stop until you open it again")
        XCTAssertEqual(menu([]).quitTitle, "Quit Nessie Computer")
        XCTAssertEqual(menu([team("a", "A", daemon: .stopped)]).quitTitle, "Quit Nessie Computer")
    }

    /// The same menu in Czech, so plural forms and words come from one place.
    func testTheMenuSpeaksTheChosenLanguage() {
        let teams = [team("a", "Prodej · Acme"), team("b", "B"), team("c", "C"), team("d", "D", paused: true)]
        let model = ComputerMenuModel(teams: teams, language: .czech)
        XCTAssertEqual(model.status, "Pracuje pro 3 týmy · 1 pozastavený")
        XCTAssertEqual(model.quitTitle, "Ukončit Nessie Computer — agenti se zastaví, dokud ho znovu neotevřete")
        guard case let .submenu(title, lines) = model.pauseMenu else { return XCTFail("a submenu") }
        XCTAssertEqual(title, "Pozastavit")
        XCTAssertEqual(lines[0].title, "Všechny týmy")
    }
}
