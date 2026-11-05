import AppKit
import Combine

/// The icon beside the clock and the menu behind it.
///
/// The menu is rebuilt from the model on every change, so it can never offer an
/// action the current state would refuse, and the icon is recomputed from the
/// same value — there is no second place that decides what the app is showing.
@MainActor
final class StatusItemController: NSObject, NSMenuDelegate {
    /// Held strongly and for the app's whole life. An `NSStatusItem` that is not
    /// retained is removed from the menu bar the moment it is released, which
    /// looks exactly like an app that never started.
    private let statusItem: NSStatusItem
    private let connections: ExecutorConnections
    private var controller: ExecutorController { connections.selected }
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
            .sink { [weak self] _ in Task { @MainActor in self?.render(self?.controller.model) } }
            .store(in: &observations)
        render(controller.model)
    }

    private func render(_ model: MenuModel?) {
        guard let model, let button = statusItem.button else { return }
        let sync = folderSyncOverview()
        let icon = menuIcon(for: model, syncNeedsYou: sync?.line.needsYou == true)
        button.image = StatusItemIcon.image(for: icon)
        button.imagePosition = .imageOnly
        button.toolTip = menuToolTip(header: menuHeader(for: model), sync: sync)
        button.setAccessibilityLabel(menuToolTip(header: menuHeader(for: model), sync: sync))
        statusItem.isVisible = true
        rebuildMenu(model, sync: sync)
    }

    /// Sync is per team, so the line is about the team that most needs the
    /// person, read from each connection's latest `describe`.
    private func folderSyncOverview() -> FolderSyncOverview? {
        FolderSyncOverview.mostDemanding(connections.controllers.compactMap { controller in
            controller.model.description.map { (executorId: $0.executorId, summary: $0.folderSync) }
        })
    }

    private func rebuildMenu(_ model: MenuModel, sync: FolderSyncOverview?) {
        guard let menu = statusItem.menu else { return }
        menu.removeAllItems()
        let header = NSMenuItem(title: menuHeader(for: model), action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        for connection in connections.controllers {
            let item = NSMenuItem(
                title: connections.label(connection), action: #selector(selectConnection(_:)), keyEquivalent: ""
            )
            item.target = self
            item.representedObject = connection.stateDirectory
            item.state = connection === controller ? .on : .off
            menu.addItem(item)
        }
        let add = NSMenuItem(title: "Add team…", action: #selector(addConnection), keyEquivalent: "")
        add.target = self
        menu.addItem(add)
        menu.addItem(.separator())

        let start = NSMenuItem(title: "Start executor", action: #selector(startDaemon), keyEquivalent: "")
        start.target = self
        start.isEnabled = startIsAvailable(for: model) && !controller.busy
        menu.addItem(start)

        let stop = NSMenuItem(title: "Stop executor", action: #selector(stopDaemon), keyEquivalent: "")
        stop.target = self
        stop.isEnabled = stopIsAvailable(for: model) && !controller.busy
        menu.addItem(stop)
        menu.addItem(.separator())

        // The surfaces this app exists for. They are always offered, even
        // unpaired: "where it can reach" answering "nothing yet, pair this Mac"
        // is the answer a person came for, and a hidden menu line is a capability
        // nobody can find. Each one opens the single window on that section; the
        // Sync line shows its live status and opens the team that status is about.
        for section in ConsoleSection.allCases {
            let isSync = section == .sync
            let item = NSMenuItem(
                title: isSync ? folderSyncMenuTitle(sync) : section.menuTitle,
                action: #selector(openSection(_:)),
                keyEquivalent: ""
            )
            item.target = self
            // The line carries its own target, so the menu keeps no selection
            // that could drift from what it shows.
            item.representedObject = ConsoleTarget(section: section, executorId: isSync ? sync?.executorId : nil)
            menu.addItem(item)
        }
        menu.addItem(.separator())

        let nessie = NSMenuItem(title: "Open Nessie", action: #selector(openNessie), keyEquivalent: "")
        nessie.target = self
        menu.addItem(nessie)
        menu.addItem(.separator())

        let quit = NSMenuItem(title: quitLabel(for: model), action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    func menuWillOpen(_ menu: NSMenu) {
        controller.refresh()
    }

    @objc private func startDaemon() { controller.startDaemon() }

    @objc private func selectConnection(_ sender: NSMenuItem) {
        guard let directory = sender.representedObject as? String else { return }
        connections.selectedDirectory = directory
        console.showTeams()
    }

    @objc private func addConnection() {
        connections.add()
        console.showTeams(pair: true)
    }

    @objc private func stopDaemon() { controller.stopDaemon() }

    @objc private func openSection(_ sender: NSMenuItem) {
        guard let target = sender.representedObject as? ConsoleTarget else { return }
        console.show(target)
    }

    @objc private func openNessie() {
        NSWorkspace.shared.open(controller.nessieExecutorsURL)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
