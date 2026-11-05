import XCTest

/// Two copies of this app now exist on a Mac that has Nessie Desktop and the
/// standalone install. They share a bundle identifier, a state directory and a
/// daemon lease, so the second launch must hand over rather than add a second
/// icon beside the clock.
final class SingleInstanceTests: XCTestCase {
    func testAFirstLaunchKeepsGoing() {
        XCTAssertEqual(
            singleInstanceDecision(ownProcessIdentifier: 501, instancesClaimingTheBundleIdentifier: []),
            .continueLaunching
        )
        // macOS lists this process among the instances for its own bundle
        // identifier. Seeing only itself is still a first launch.
        XCTAssertEqual(
            singleInstanceDecision(
                ownProcessIdentifier: 501,
                instancesClaimingTheBundleIdentifier: [RunningInstance(processIdentifier: 501)]
            ),
            .continueLaunching
        )
    }

    /// The nested copy inside Nessie Desktop and an `/Applications` install are
    /// the same product. Whichever launches second activates the other and exits.
    func testASecondLaunchActivatesTheInstanceThatAlreadyHasTheStatusItem() {
        let running = RunningInstance(
            processIdentifier: 412,
            bundlePath: "/Applications/Nessie Executor.app"
        )
        XCTAssertEqual(
            singleInstanceDecision(
                ownProcessIdentifier: 913,
                instancesClaimingTheBundleIdentifier: [running, RunningInstance(processIdentifier: 913)]
            ),
            .activateExisting(running)
        )
    }

    /// Two copies launched in the same moment must not each decide the *other*
    /// should live, leaving no status item at all. A deterministic total order —
    /// the lowest pid, not the listing order — makes that impossible: whichever
    /// asks, the answer names the same process.
    func testTwoSimultaneousLaunchesAgreeOnWhichInstanceSurvives() {
        let first = RunningInstance(processIdentifier: 412, bundlePath: "/Applications/Nessie Executor.app")
        let second = RunningInstance(
            processIdentifier: 913,
            bundlePath: "/Applications/Nessie.app/Contents/Library/LoginItems/Nessie Executor.app"
        )
        XCTAssertEqual(
            singleInstanceDecision(
                ownProcessIdentifier: 913,
                instancesClaimingTheBundleIdentifier: [second, first]
            ),
            .activateExisting(first)
        )
        // The survivor asking the same question is told to keep going, because the
        // only other instance named is itself.
        XCTAssertEqual(
            singleInstanceDecision(
                ownProcessIdentifier: 412,
                instancesClaimingTheBundleIdentifier: [first]
            ),
            .continueLaunching
        )
        // Listing order must not change the answer.
        XCTAssertEqual(
            singleInstanceDecision(
                ownProcessIdentifier: 913,
                instancesClaimingTheBundleIdentifier: [first, second]
            ),
            .activateExisting(first)
        )
    }

    /// Three copies is not a special case: the lowest pid keeps the status item.
    func testTheLowestProcessIdentifierWinsWhateverElseIsRunning() {
        guard case let .activateExisting(existing) = singleInstanceDecision(
            ownProcessIdentifier: 999,
            instancesClaimingTheBundleIdentifier: [
                RunningInstance(processIdentifier: 780),
                RunningInstance(processIdentifier: 999),
                RunningInstance(processIdentifier: 341)
            ]
        ) else { return XCTFail("a launch beside other instances must defer") }
        XCTAssertEqual(existing.processIdentifier, 341)
    }

    /// A pid macOS could not report is not somebody to hand over to.
    func testAnUnusablePidIsNotTreatedAsARunningInstance() {
        XCTAssertEqual(
            singleInstanceDecision(
                ownProcessIdentifier: 501,
                instancesClaimingTheBundleIdentifier: [
                    RunningInstance(processIdentifier: -1),
                    RunningInstance(processIdentifier: 0)
                ]
            ),
            .continueLaunching
        )
    }
}
