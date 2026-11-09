import AppKit
import Sentry

/// A status-bar-only app: `LSUIElement` keeps it out of the Dock and the app
/// switcher, so the icon beside the clock is the whole of its presence — which
/// is why every one of its three surfaces hangs off that icon's menu.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controller: ExecutorConnections?
    // Held for the app's whole life: the status item lives inside this object,
    // and an unretained status item disappears from the menu bar immediately.
    private var statusItem: StatusItemController?
    private var console: ConsoleWindowController?
    /// Held so the observer lives as long as the app does.
    private var secondLaunchObserver: NSObjectProtocol?
    private let updates = ExecutorUpdateMonitor()

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let dsn = Bundle.main.object(forInfoDictionaryKey: "NessieSentryDSN") as? String, !dsn.isEmpty {
            SentrySDK.start { options in
                options.dsn = dsn
                options.enableUncaughtNSExceptionReporting = true
            }
        }
        let controller = ExecutorConnections(isDevelopmentBuild: AppBuild.isDevelopment)
        let console = ConsoleWindowController(connections: controller)
        self.controller = controller
        self.console = console
        self.statusItem = StatusItemController(connections: controller, console: console)
        // A second copy — the nested helper inside Nessie Desktop, or the
        // standalone install — exits rather than adding a second status icon, and
        // asks this instance to come forward on its way out. Opening the window
        // is what a person can actually see happen.
        self.secondLaunchObserver = MenuBarSingleInstance.observeSecondLaunches { [weak console] in
            console?.show(ConsoleTarget(section: .settings))
        }
        try? ComputerUpdateService.prepare()
        if ComputerUpdateService.unavailableStatus() != nil { console.show(ConsoleTarget(section: .settings)) }
        controller.start()
        updates.start(console: console, connections: controller)
    }

    /// Quitting stops the daemon, and waits for it: this app's daemon is its own
    /// child, and a sandbox mid-teardown is waited for rather than killed.
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
