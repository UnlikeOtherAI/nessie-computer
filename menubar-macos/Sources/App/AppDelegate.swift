import AppKit

/// A status-bar-only app: `LSUIElement` keeps it out of the Dock and the app
/// switcher, so the icon beside the clock and the one window are its whole
/// presence.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controller: ExecutorConnections?
    // Held for the app's whole life: the status item lives inside this object,
    // and an unretained status item disappears from the menu bar immediately.
    private var statusItem: StatusItemController?
    private var console: ConsoleWindowController?
    private var notifier: ProgramRequestNotifier?
    /// Held so the observer lives as long as the app does.
    private var secondLaunchObserver: NSObjectProtocol?
    private let updates = ExecutorUpdateMonitor()
    /// A link that arrived before the window existed.
    private var pendingLinks: [DeepLink] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = ExecutorConnections(isDevelopmentBuild: AppBuild.isDevelopment)
        let console = ConsoleWindowController(connections: controller)
        let notifier = ProgramRequestNotifier(connections: controller, console: console)
        self.controller = controller
        self.console = console
        self.notifier = notifier
        self.statusItem = StatusItemController(connections: controller, console: console)
        // A second copy — the nested helper inside Nessie Desktop, or the
        // standalone install — exits rather than adding a second status icon, and
        // asks this instance to come forward on its way out, with the link it was
        // opened with. Opening the window is what a person can actually see happen.
        self.secondLaunchObserver = MenuBarSingleInstance.observeSecondLaunches { [weak self] links in
            guard let self else { return }
            if links.isEmpty { self.console?.show(ConsoleTarget()) }
            links.forEach(self.follow)
        }
        try? ComputerUpdateService.prepare()
        ComputerUpdateHealth.shared.onChange = { [weak controller] attention in
            controller?.updateAttention = attention
        }
        // The first launch with no team opens the window, which opens straight
        // on a pairing code, rather than leaving a person to find an icon.
        let hasTeam = controller.controllers.contains { ExecutorPaths.hasPairingFile($0.stateDirectory) }
        if !pendingLinks.isEmpty {
            pendingLinks.forEach(follow)
            pendingLinks = []
        } else if !hasTeam {
            console.show(ConsoleTarget())
        } else if ComputerUpdateService.unavailableStatus() != nil {
            console.show(ConsoleTarget(section: .settings))
        }
        controller.start()
        notifier.start()
        updates.start(console: console, connections: controller)
    }

    /// `nessie-computer://` links. They only navigate; see `DeepLink`.
    func application(_ application: NSApplication, open urls: [URL]) {
        let links = urls.compactMap(DeepLink.parse)
        guard console != nil else {
            pendingLinks += links
            return
        }
        links.forEach(follow)
    }

    private func follow(_ link: DeepLink) {
        switch link {
        case let .open(target): console?.show(target)
        case .connect: console?.showConnect()
        }
    }

    /// Opening the app again — from Finder, Spotlight or Launchpad — opens its window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        console?.show(ConsoleTarget())
        return false
    }

    /// Quitting stops every daemon, and waits for them: they are this app's own
    /// children, and a sandbox mid-teardown is waited for rather than killed.
    /// Pauses stay exactly as they were.
    func applicationWillTerminate(_ notification: Notification) {
        controller?.shutdown()
        updates.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

enum AppBuild {
    /// The one switch that decides which API origin this build may pair with and
    /// whether a state directory may be overridden. It is a compile-time fact,
    /// not a setting: a release that could be talked into development behaviour
    /// would not be a release.
    static let isDevelopment: Bool = {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }()
}
