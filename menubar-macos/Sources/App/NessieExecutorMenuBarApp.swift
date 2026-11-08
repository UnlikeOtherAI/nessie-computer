import AppKit

/// A hand-rolled `main` rather than a SwiftUI `App`: this app has no window at
/// launch and no Dock presence, so it sets the accessory activation policy
/// before anything else exists, and the delegate is held here because
/// `NSApplication.delegate` does not retain it.
@main
enum NessieExecutorMenuBarApp {
    @MainActor private static var delegate: AppDelegate?
    @MainActor private static var handover: SecondLaunchHandover?

    @MainActor
    static func main() {
        // The command line's `settings login`: answered before anything of the app exists.
        if let command = LoginItemCommand.parse(CommandLine.arguments) { exit(LoginItemCommandRunner.run(command)) }
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        // Before a status item, a controller or a daemon child exists. A Mac with
        // both Nessie Desktop and the standalone install has two copies of this
        // app sharing one bundle identifier, one state directory and one daemon
        // lease; whichever is launched second has nothing of its own to do.
        if let existing = MenuBarSingleInstance.runningInstance() {
            // A `nessie-computer://` link that launched this copy arrives only
            // once it runs: it is taken, handed to the running copy, and then
            // this copy exits without a status item or a daemon.
            let handover = SecondLaunchHandover(existing: existing)
            Self.handover = handover
            application.delegate = handover
            application.run()
            return
        }
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

    /// The instance that already holds the bundle identifier, when there is one;
    /// this process then hands over to it and exits.
    static func runningInstance() -> RunningInstance? {
        guard let identifier = Bundle.main.bundleIdentifier else { return nil }
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
        guard case let .activateExisting(existing) = decision else { return nil }
        return existing
    }

    /// Asks the running copy to come forward, with the links this copy was
    /// opened with (none: it opens its window on Overview).
    static func handOver(_ urls: [URL], to existing: RunningInstance) {
        NSRunningApplication(processIdentifier: existing.processIdentifier)?
            .activate(options: [])
        DistributedNotificationCenter.default().postNotificationName(
            showWindowNotification, object: nil, userInfo: DeepLink.handoverUserInfo(urls), deliverImmediately: true
        )
    }

    /// Answering the notification above. The observer is added by the instance
    /// that stayed, and dropped with it. Any local process can post it, so the
    /// links are parsed again here, and a link only ever navigates.
    static func observeSecondLaunches(_ follow: @escaping @MainActor ([DeepLink]) -> Void) -> NSObjectProtocol {
        DistributedNotificationCenter.default().addObserver(
            forName: showWindowNotification,
            object: nil,
            queue: .main
        ) { notification in
            let links = DeepLink.handedOver(notification.userInfo)
            MainActor.assumeIsolated { follow(links) }
        }
    }
}

/// The delegate of a copy launched while another runs. macOS delivers the
/// link that launched it after `finishLaunching`, before
/// `applicationDidFinishLaunching`; a copy that exited before running, as it
/// once did, lost the link.
@MainActor
final class SecondLaunchHandover: NSObject, NSApplicationDelegate {
    private let existing: RunningInstance
    private var urls: [URL] = []

    init(existing: RunningInstance) {
        self.existing = existing
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        self.urls += urls
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // One more turn of the run loop lets a link sent as a later event in.
        DispatchQueue.main.async { [self] in
            MenuBarSingleInstance.handOver(urls, to: existing)
            NSApp.terminate(nil)
        }
    }
}
