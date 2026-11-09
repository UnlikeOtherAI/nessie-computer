import AppKit
import Combine

/// The icon beside the clock and the menu behind it.
///
/// The menu is rebuilt from `ComputerMenuModel` on every change, so it can
/// never offer an action the current state would refuse, and the icon is
/// recomputed from the same value — there is no second place that decides
/// what the app is showing. It speaks about every team at once: there is no
/// selected team, and a line about one team names it.
@MainActor
final class StatusItemController: NSObject, NSMenuDelegate {
    /// Held strongly and for the app's whole life. An `NSStatusItem` that is not
    /// retained is removed from the menu bar the moment it is released, which
    /// looks exactly like an app that never started.
    private let statusItem: NSStatusItem
    private let connections: ExecutorConnections
    private let console: ConsoleWindowController
    private var observations: Set<AnyCancellable> = []

    init(connections: ExecutorConnections, console: ConsoleWindowController) {
        self.connections = connections
        self.console = console
        self.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        // Named so macOS remembers where a person dragged it and keeps it across
        // launches instead of appending it at the end of a crowded menu bar.
        statusItem.autosaveName = "com.unlikeotherai.nessie.executor.menubar.status"
        statusItem.behavior = []
        statusItem.isVisible = true
        statusItem.menu = NSMenu()
        statusItem.menu?.delegate = self
        connections.objectWillChange
            .sink { [weak self] _ in Task { @MainActor in self?.render() } }
            .store(in: &observations)
        render()
    }

    private func render() {
        guard let button = statusItem.button else { return }
        let model = connections.menuModel()
        button.image = StatusItemIcon.image(for: model.icon, description: model.iconDescription)
        button.imagePosition = .imageOnly
        button.toolTip = model.toolTip
        button.setAccessibilityLabel(model.toolTip)
        statusItem.isVisible = true
        rebuildMenu(model)
    }

    private func item(_ title: String, _ action: Selector?, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    private func rebuildMenu(_ model: ComputerMenuModel) {
        guard let menu = statusItem.menu else { return }
        menu.removeAllItems()
        let status = item(model.status, nil)
        status.isEnabled = false
        menu.addItem(status)
        if let needsYou = model.needsYou {
            // The line carries its own target, so the menu keeps no selection
            // that could drift from what it shows.
            let line = item(needsYou.title, #selector(openTarget(_:)))
            line.representedObject = needsYou
            menu.addItem(line)
        }
        menu.addItem(.separator())
        menu.addItem(pauseItem(model.pauseMenu))
        menu.addItem(.separator())
        let window = item(Word.openComputer.text(in: model.language), #selector(openWindow))
        menu.addItem(window)
        menu.addItem(item(Word.addAnotherTeam.text(in: model.language), #selector(addAnotherTeam)))
        menu.addItem(item(Word.openNessie.text(in: model.language), #selector(openNessie)))
        menu.addItem(.separator())
        menu.addItem(item(model.quitTitle, #selector(quit), key: "q"))
    }

    private func pauseItem(_ pause: PauseMenu) -> NSMenuItem {
        switch pause {
        case let .unavailable(title):
            let line = item(title, nil)
            line.isEnabled = false
            return line
        case let .single(line):
            return pauseLine(line)
        case let .submenu(title, lines):
            let parent = item(title, nil)
            let submenu = NSMenu(title: title)
            for (index, line) in lines.enumerated() {
                submenu.addItem(pauseLine(line))
                if index == 0 { submenu.addItem(.separator()) }
            }
            parent.submenu = submenu
            return parent
        }
    }

    private func pauseLine(_ line: PauseMenu.Line) -> NSMenuItem {
        let menuItem = item(line.title, #selector(togglePause(_:)))
        menuItem.state = line.checked ? .on : .off
        menuItem.representedObject = line
        return menuItem
    }

    func menuWillOpen(_ menu: NSMenu) {
        connections.refresh()
    }

    @objc private func openTarget(_ sender: NSMenuItem) {
        guard let needsYou = sender.representedObject as? NeedsYouItem else { return }
        console.show(needsYou.target)
    }

    /// Pause and Resume take effect at once, with no question first. A pause
    /// that could not be saved is said out loud: an owner who believes agents
    /// are kept out must not be left guessing.
    @objc private func togglePause(_ sender: NSMenuItem) {
        guard let line = sender.representedObject as? PauseMenu.Line else { return }
        Task { @MainActor in
            do {
                try await connections.setPaused(line.executorId, paused: line.pause)
            } catch {
                let alert = NSAlert()
                alert.messageText = Word.changeRefused.text
                alert.informativeText = (error as? ExecutorRefusal)?.message ?? error.localizedDescription
                NSApp.activate(ignoringOtherApps: true)
                alert.runModal()
            }
        }
    }

    @objc private func openWindow() {
        console.show(ConsoleTarget())
    }

    /// Opens the window straight onto a new pairing code, as the dropdown's
    /// **＋ Add another team** does.
    @objc private func addAnotherTeam() {
        console.showConnect()
    }

    @objc private func openNessie() {
        NSWorkspace.shared.open(connections.nessieConsoleURL)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
