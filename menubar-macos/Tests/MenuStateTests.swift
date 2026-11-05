import XCTest

final class MenuStateTests: XCTestCase {
    func testNothingPairedIsStoppedAndSaysSo() {
        let model = MenuModel(pairing: .unpaired, daemon: .stopped)
        XCTAssertEqual(menuIcon(for: model), .stopped)
        XCTAssertEqual(menuHeader(for: model), "Nessie Executor — nothing paired")
        XCTAssertFalse(startIsAvailable(for: model))
    }

    func testARunningDaemonIsTheRunningIcon() {
        let model = MenuModel(pairing: .paired(sampleDescription()), daemon: .running)
        XCTAssertEqual(menuIcon(for: model), .running)
        XCTAssertEqual(menuHeader(for: model), "Nessie Executor — running")
        XCTAssertTrue(stopIsAvailable(for: model))
        XCTAssertFalse(startIsAvailable(for: model))
    }

    /// Work in flight outranks anything else: a person watching for a daemon to
    /// finish tearing down must not see the icon claim everything is fine.
    func testWorkInFlightNeedsAttention() {
        for state in [DaemonState.stopping, .awaitingConfirmation] {
            let model = MenuModel(pairing: .paired(sampleDescription()), daemon: state)
            XCTAssertEqual(menuIcon(for: model), .needsAttention, "\(state) must need attention")
        }
    }

    /// The state that must never be mistaken for any other, and the one a cached
    /// last-known-good icon would hide.
    func testAnUnavailableRuntimeIsAttentionAndItsReasonReachesTheMenu() {
        let model = MenuModel(
            pairing: .unavailable("the packaged executor runtime is missing — reinstall Nessie Executor"),
            daemon: .stopped
        )
        XCTAssertEqual(menuIcon(for: model), .needsAttention)
        XCTAssertEqual(
            menuHeader(for: model),
            "Nessie Executor — the packaged executor runtime is missing — reinstall Nessie Executor"
        )
        XCTAssertFalse(startIsAvailable(for: model))
    }

    /// Paired but stopped reads the same as nothing paired, deliberately:
    /// stopping the executor on purpose must not light the menu bar up.
    func testStoppingOnPurposeDoesNotLightTheMenuBarUp() {
        let model = MenuModel(pairing: .paired(sampleDescription()), daemon: .stopped)
        XCTAssertEqual(menuIcon(for: model), .stopped)
        XCTAssertTrue(startIsAvailable(for: model))
    }

    /// Unlike the Windows tray, quitting here ends the daemon, so Quit says so.
    func testQuitSaysWhatItDoesToTheDaemon() {
        XCTAssertEqual(
            quitLabel(for: MenuModel(pairing: .paired(sampleDescription()), daemon: .running)),
            "Quit Nessie Executor (stops the running executor)"
        )
        XCTAssertEqual(
            quitLabel(for: MenuModel(pairing: .unpaired, daemon: .stopped)),
            "Quit Nessie Executor"
        )
    }

}
