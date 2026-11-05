import Foundation

/// One product, one status item.
///
/// Two copies of this app exist on a Mac that has both Nessie Desktop and the
/// standalone install: the nested helper at
/// `Nessie.app/Contents/Library/LoginItems/Nessie Executor.app`, and whatever was
/// dragged into an Applications folder. They share a bundle identifier, a state
/// directory and a daemon lease, so a second launch has nothing of its own to
/// do — and two icons beside the clock for one product is the failure mode this
/// rule exists to prevent.
///
/// The decision is a pure function over the instances macOS reports for this
/// bundle identifier, so it is testable without a second process, a window
/// server or a host application.
public struct RunningInstance: Equatable, Sendable {
    public let processIdentifier: Int32
    /// Where that instance was launched from. Only ever used to explain a
    /// decision; nothing is launched from it and nothing is verified against it.
    public let bundlePath: String?

    public init(processIdentifier: Int32, bundlePath: String? = nil) {
        self.processIdentifier = processIdentifier
        self.bundlePath = bundlePath
    }
}

public enum SingleInstanceDecision: Equatable, Sendable {
    /// Bring the instance that already owns the status item forward, then exit.
    case activateExisting(RunningInstance)
    /// Nothing else holds the bundle identifier: this process is the one.
    case continueLaunching
}

/// Which of the processes claiming this bundle identifier keeps the status item.
///
/// The lowest process identifier that is not this one, rather than "the first
/// one macOS happened to list": that order is not documented as stable, and two
/// copies launched in the same moment must not be able to each decide the *other*
/// should live and both exit. A deterministic total order makes that impossible.
///
/// Own pid is passed in rather than read, because a test has exactly one process
/// and still has to be able to describe two.
public func singleInstanceDecision(
    ownProcessIdentifier: Int32,
    instancesClaimingTheBundleIdentifier instances: [RunningInstance]
) -> SingleInstanceDecision {
    let others = instances
        .filter { $0.processIdentifier != ownProcessIdentifier && $0.processIdentifier > 0 }
        .sorted { $0.processIdentifier < $1.processIdentifier }
    guard let existing = others.first else { return .continueLaunching }
    return .activateExisting(existing)
}
