import AppKit
import WebKit

/// The same packaged document as Windows, with a process-local native bridge.
@MainActor
final class ConsoleWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate {
    private let connections: ExecutorConnections
    private var window: NSWindow?
    private var webView: WKWebView?
    private var bridge: ExecutorConsoleBridge?
    private var entryURL: URL?
    private var target = ConsoleTarget()
    private var connect = false
    private var update = false

    init(connections: ExecutorConnections) { self.connections = connections }

    func showUpdate() {
        show(ConsoleTarget(section: .settings))
        update = true
        selectSection()
    }

    /// Add another team, over the tab last used: the page asks for a code at once.
    func showConnect() {
        show(ConsoleTarget())
        connect = true
        selectSection()
    }

    func show(_ target: ConsoleTarget) {
        self.target = target
        update = false
        connect = false
        if let window {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            selectSection()
            return
        }
        guard let folder = Bundle.main.resourceURL?.appendingPathComponent("executor-console") else { return }
        // WebKit reports absolute request URLs. Bundle resources may retain a
        // base URL, which Foundation otherwise compares as a different URL.
        let entry = folder.appendingPathComponent("index.html").absoluteURL
        let bridge = ExecutorConsoleBridge(connections: connections, entryURL: entry)
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "executor")
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 640, height: 680), configuration: configuration)
        webView.navigationDelegate = self
        let window = NSWindow(
            contentRect: webView.frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
        )
        // The product's name in every language.
        window.title = "Nessie Computer"
        window.minSize = NSSize(width: 440, height: 500)
        window.contentView = webView
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        self.bridge = bridge
        self.webView = webView
        self.window = window
        entryURL = entry
        webView.loadFileURL(entry, allowingReadAccessTo: folder)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func selectSection() {
        if update {
            webView?.evaluateJavaScript("window.dispatchEvent(new Event('executor://update-available'))")
        }
        webView?.evaluateJavaScript(target.script)
        if connect { webView?.evaluateJavaScript(ConsoleTarget.connectScript) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) { selectSection() }

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        decisionHandler(navigationAction.request.url == entryURL ? .allow : .cancel)
    }

    /// Closing hides the window rather than tearing the page down, as on
    /// Windows, so a setting still saving finishes and the page keeps its state.
    /// The window's own close button is the only way to close it.
    func hide() {
        window?.orderOut(nil)
        connections.controllers.forEach { $0.pairing.restore() }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hide()
        return false
    }

    func windowWillClose(_ notification: Notification) {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "executor")
        window = nil
        webView = nil
        bridge = nil
        connections.controllers.forEach { $0.pairing.restore() }
    }
}
