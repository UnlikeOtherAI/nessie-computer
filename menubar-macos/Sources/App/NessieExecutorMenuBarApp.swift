import AppKit

/// A hand-rolled `main` rather than a SwiftUI `App`: this app has no window at
/// launch and no Dock presence, so it sets the accessory activation policy
/// before anything else exists, and the delegate is held here because
/// `NSApplication.delegate` does not retain it.
@main
enum NessieExecutorMenuBarApp {
    @MainActor private static var delegate: AppDelegate?

    @MainActor
    static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        // Before a status item, a controller or a daemon child exists. A Mac with
        // both Nessie Desktop and the standalone install has two copies of this
        // app sharing one bundle identifier, one state directory and one daemon
        // lease; whichever is launched second has nothing of its own to do.
        if MenuBarSingleInstance.deferToARunningInstance() { return }
        let delegate = AppDelegate()
        Self.delegate = delegate
        application.delegate = delegate
        application.run()
    }
}

/// The AppKit half of [`singleInstanceDecision`]: it reads the instances macOS
/// reports for this bundle identifier and acts on the decision. The decision
/// itself is a pure function in `Sources/Core` so it can be tested without a
/// second process.
@MainActor
enum MenuBarSingleInstance {
    /// Posted by a second launch, observed by the instance that already owns the
    /// status item. An accessory app has nothing on screen to raise, so
    /// "activate the existing one" has to mean something a person can see:
    /// the running copy opens its window. Distributed notifications are
    /// available because this app is deliberately not sandboxed.
    static let showWindowNotification = Notification.Name(
        "com.unlikeotherai.nessie.executor.menubar.showWindow"
    )

    /// True when another instance already holds the bundle identifier, in which
    /// case this process has asked it to come forward and must now exit.
    static func deferToARunningInstance() -> Bool {
        guard let identifier = Bundle.main.bundleIdentifier else { return false }
        let instances = NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
            .map {
                RunningInstance(
                    processIdentifier: $0.processIdentifier,
                    bundlePath: $0.bundleURL?.path
                )
            }
        let decision = singleInstanceDecision(
            ownProcessIdentifier: ProcessInfo.processInfo.processIdentifier,
            instancesClaimingTheBundleIdentifier: instances
        )
        guard case let .activateExisting(existing) = decision else { return false }
        NSRunningApplication(processIdentifier: existing.processIdentifier)?
            .activate(options: [])
        DistributedNotificationCenter.default()
            .postNotificationName(showWindowNotification, object: nil, userInfo: nil, deliverImmediately: true)
        return true
    }

    /// Answering the notification above. The observer is added by the instance
    /// that stayed, and dropped with it.
    static func observeSecondLaunches(_ show: @escaping @MainActor () -> Void) -> NSObjectProtocol {
        DistributedNotificationCenter.default().addObserver(
            forName: showWindowNotification,
            object: nil,
            queue: .main
        ) { _ in
            MainActor.assumeIsolated { show() }
        }
    }
}
