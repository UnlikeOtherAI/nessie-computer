import AppKit
import WebKit

@MainActor
final class ExecutorConsoleBridge: NSObject, WKScriptMessageHandlerWithReply {
    private let connections: ExecutorConnections
    private let entryURL: URL
    var close: (() -> Void)?

    init(connections: ExecutorConnections, entryURL: URL) {
        self.connections = connections
        self.entryURL = entryURL
    }

    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url == entryURL,
              let body = message.body as? [String: Any], let command = body["command"] as? String else {
            replyHandler(nil, "Only the local executor window can change this computer's settings.")
            return
        }
        Task {
            do {
                replyHandler(try await invoke(command, args: body["args"] as? [String: Any] ?? [:]), nil)
            } catch let refusal as ExecutorRefusal {
                replyHandler(nil, refusal.message)
            } catch {
                replyHandler(nil, error.localizedDescription)
            }
        }
    }

    private func selected(_ args: [String: Any]) throws -> ExecutorController {
        guard let identifier = args["executorId"] as? String else { return connections.selected }
        guard let controller = connections.controllers.first(where: {
            $0.model.description?.executorId == identifier
        }) else { throw ExecutorRefusal("This team is not paired on this computer.") }
        return controller
    }

    private func text(_ args: [String: Any], _ key: String) throws -> String {
        guard let value = args[key] as? String, !value.isEmpty else { throw ExecutorRefusal("Missing \(key).") }
        return value
    }

    private func run(_ invocation: ExecutorCLIInvocation, controller: ExecutorController) async throws -> Data {
        let runtime = try PackagedRuntime.locate(in: Bundle.main.resourceURL).get()
        let runner = ExecutorProcessRunner(runtime: runtime, isDevelopmentBuild: controller.isDevelopmentBuild)
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let completed = try runner.run(invocation)
                    guard completed.succeeded else {
                        throw ExecutorProcessRunner.refusal(
                            from: completed, fallback: "The local executor refused this change."
                        )
                    }
                    continuation.resume(returning: Data(completed.standardOutput.utf8))
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    private func json(_ invocation: ExecutorCLIInvocation, controller: ExecutorController) async throws -> Any {
        try JSONSerialization.jsonObject(with: await run(invocation, controller: controller))
    }

    /// Every paired connection, with the reason it last failed so the Teams
    /// overview can say why a connection is not running.
    private func view() -> [String: Any] {
        ["kind": "reachable", "executors": connections.controllers.compactMap { controller -> [String: String]? in
            guard let description = controller.model.description else { return nil }
            var row = ["executorId": description.executorId, "daemonStatus": controller.model.daemon.rawValue]
            // An unrecognised refusal's explanation only introduces its quote, so the quote is shown.
            if let failure = controller.failure {
                row["detail"] = failure.code == nil && !failure.detail.isEmpty
                    ? "Couldn’t connect: \(failure.detail)" : failure.explanation
            }
            return row
        }]
    }

    /// One saved setting: stop, write, and restart the connection if it was
    /// running, all without blocking the window.
    private func configure(_ args: [String: Any], controller: ExecutorController) async throws -> Any {
        guard let input = args["configurationInput"] as? [String: Any] else {
            throw ExecutorRefusal("Missing local configuration.")
        }
        let wasRunning = controller.model.daemon == .running
        guard await controller.stopDaemonWithoutBlocking() else {
            throw ExecutorRefusal("Wait for this executor to stop.")
        }
        defer { controller.refresh(startWhenPaired: wasRunning) }
        let invocation = ExecutorCLIInvocation(
            arguments: ["configure", "--configuration-input-stdin", "--state-dir", controller.stateDirectory],
            standardInput: try JSONSerialization.data(withJSONObject: input)
        )
        _ = try await run(invocation, controller: controller)
        return try await json(ExecutorCLI.describe(stateDirectory: controller.stateDirectory), controller: controller)
    }

    /// The global switch: every paired connection on or off, with no dialogs.
    private func setRunning(_ args: [String: Any]) async throws -> Any {
        guard let running = args["running"] as? Bool else { throw ExecutorRefusal("Choose on or off.") }
        var stillStopping = false
        for controller in connections.controllers where controller.model.description != nil {
            // The latest request wins over a start still under way: Off waits for
            // that start to finish, and the start then stops what it produced.
            controller.wantsDaemon = running
            if running {
                controller.startDaemon()
                continue
            }
            while controller.busy { try? await Task.sleep(nanoseconds: 50_000_000) }
            if !(await controller.stopDaemonWithoutBlocking()) { stillStopping = true }
        }
        guard !stillStopping else {
            throw ExecutorRefusal("Some connections are still stopping. Try again in a moment.")
        }
        return view()
    }

    /// Removes a team from this Mac. The runtime signs off with Nessie, then
    /// deletes the connection's directory; the answer says whether Nessie heard.
    private func remove(_ controller: ExecutorController) async throws -> Any {
        guard controller.model.description != nil else {
            throw ExecutorRefusal("This team is not paired on this computer.")
        }
        guard await controller.stopDaemonWithoutBlocking() else {
            throw ExecutorRefusal("Wait for this team's connection to stop, then remove it.")
        }
        controller.pairing.shutdown()
        let result = try await json(
            ExecutorCLI.unpair(stateDirectory: controller.stateDirectory), controller: controller
        )
        connections.remove(controller)
        return ["signedOff": (result as? [String: Any])?["signedOff"] as? Bool == true]
    }

    /// The hosted Nessie opens in its desktop app when that is installed, and
    /// in the browser otherwise; any other Nessie always opens in the browser.
    private func openNessie(_ args: [String: Any], controller: ExecutorController) async throws {
        let origin = try text(args, "apiBaseUrl")
        if ApprovedAPIOrigin.isHostedNessie(origin), let app = NessieDesktop.installedURL() {
            _ = try await NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
            return
        }
        NSWorkspace.shared.open(ApprovedAPIOrigin.consoleURL(
            forAPIOrigin: origin, isDevelopmentBuild: controller.isDevelopmentBuild
        ))
    }

    private func notify(_ args: [String: Any]) async throws {
        let title = try text(args, "title")
        let body = try text(args, "body")
        guard title.count <= 64, body.count <= 200,
              !(title + body).unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw ExecutorRefusal("That notification cannot be shown.")
        }
        try await LocalNotifications.shared.post(title: title, body: body)
    }

    private func pairing(_ command: String, args: [String: Any]) async throws -> Any {
        if command == "executor_pairing_start" { connections.add() }
        if args["executorId"] == nil, let pending = connections.controllers.first(where: {
            ExecutorStateDiscovery.pendingAttemptBlocksStart(in: $0.stateDirectory)
        }) { connections.selectedDirectory = pending.stateDirectory }
        let controller = try selected(args)
        controller.pairing.shutdown()
        let directory = controller.stateDirectory
        // A claim in Nessie completes the pairing; the status check that finds
        // an open attempt paired is the moment its daemon starts.
        let wasPending = ExecutorStateDiscovery.pendingAttemptBlocksStart(in: directory)
        let invocation: ExecutorCLIInvocation
        switch command {
        case "executor_pairing_start":
            let origin = try ApprovedAPIOrigin.approve(
                text(args, "apiBaseUrl"), isDevelopmentBuild: controller.isDevelopmentBuild
            ).get()
            try ExecutorPaths.prepare(directory)
            invocation = try ExecutorCLI.pairingStart(apiBaseUrl: origin, replace: false, stateDirectory: directory)
        case "executor_pairing_cancel": invocation = ExecutorCLI.pairingCancel(stateDirectory: directory)
        default: invocation = ExecutorCLI.pairingStatus(stateDirectory: directory)
        }
        let result = try await json(invocation, controller: controller)
        let paired = (result as? [String: Any])?["status"] as? String == "paired"
        controller.refresh(startWhenPaired: wasPending && paired)
        return result
    }

    private func invoke(_ command: String, args: [String: Any]) async throws -> Any {
        if command.hasPrefix("executor_pairing_") { return try await pairing(command, args: args) }
        switch command {
        case "executor_set_running": return try await setRunning(args)
        case "executor_notify": try await notify(args)
        case "executor_chatgpt_usage":
            if let url = URL(string: "https://chatgpt.com/settings/usage") { NSWorkspace.shared.open(url) }
        case "executor_choose_folder": return chooseFolder()
        case "executor_sync_pick_folder": return chooseSyncFolder()
        case "executor_copy_code": try copyCode(args)
        case "executor_autostart", "executor_set_autostart": return try autostart(command, args: args)
        case "executor_auto_restart", "executor_set_auto_restart": return try autoRestart(command, args: args)
        case "executor_hide_status": close?()
        default: return try await invokeConnection(command, args: args)
        }
        return NSNull()
    }

    /// The commands that act on one team's connection.
    private func invokeConnection(_ command: String, args: [String: Any]) async throws -> Any {
        let controller = try selected(args)
        switch command {
        case "executor_view": return view()
        case "executor_describe":
            return try await json(
                ExecutorCLI.describe(stateDirectory: controller.stateDirectory), controller: controller
            )
        case "executor_configure": return try await configure(args, controller: controller)
        case "executor_personal_chatgpt":
            guard args["executorId"] as? String == controller.model.description?.executorId,
                  let operation = args["operation"] as? [String: Any] else {
                throw ExecutorRefusal("Choose a paired team and local account action.")
            }
            let invocation = try PersonalChatgptControl.invocation(
                operation: operation, stateDirectory: controller.stateDirectory
            )
            let runtime = try PackagedRuntime.locate(in: Bundle.main.resourceURL).get()
            let runner = ExecutorProcessRunner(runtime: runtime, isDevelopmentBuild: controller.isDevelopmentBuild)
            let data = try await PersonalChatgptProcess().run(
                process: runner.process(for: invocation), invocation: invocation
            )
            return try JSONSerialization.jsonObject(with: data)
        case "executor_remove": return try await remove(controller)
        case "executor_open_nessie": try await openNessie(args, controller: controller)
        case "executor_reconnect":
            // One team back on, with no dialog: the Try again of a save whose team dropped.
            controller.wantsDaemon = true
            controller.startDaemon()
            return view()
        case let sync where sync.hasPrefix("executor_sync_") || sync == "executor_open_path":
            return try await invokeSync(sync, args: args, controller: controller)
        default: throw ExecutorRefusal("Unknown local executor action.")
        }
        return NSNull()
    }

    private func autostart(_ command: String, args: [String: Any]) throws -> Any {
        if command == "executor_set_autostart" {
            guard let enabled = args["enabled"] as? Bool else { throw ExecutorRefusal("Choose a login setting.") }
            if let refusal = LaunchAtLogin.set(enabled) { throw refusal }
            return NSNull()
        }
        return ["enabled": LaunchAtLogin.isEnabled]
    }

    private func autoRestart(_ command: String, args: [String: Any]) throws -> Any {
        if command == "executor_set_auto_restart" {
            guard let enabled = args["enabled"] as? Bool else { throw ExecutorRefusal("Choose a restart setting.") }
            AutoRestart.set(enabled)
            return NSNull()
        }
        return ["enabled": AutoRestart.isEnabled]
    }

    private func chooseFolder() -> Any {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let path = panel.url?.path { return WorkspaceFolder.resolvedPath(path) }
        return NSNull()
    }

    private func copyCode(_ args: [String: Any]) throws {
        let code = try text(args, "code")
        guard code.utf8.count == 8, code.utf8.allSatisfy({ (48...57).contains($0) }) else {
            throw ExecutorRefusal("Invalid pairing code.")
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
    }
}

// MARK: - Folder sync

/// The Sync tab. Every path this window opens is read from the CLI's own
/// `sync status --json`, never taken from the page, and a file is shown
/// selected in Finder rather than opened, because it may be a program.
extension ExecutorConsoleBridge {
    private static let missingSyncFolder = "The sync folder is missing. Choose it again."

    private func invokeSync(
        _ command: String, args: [String: Any], controller: ExecutorController
    ) async throws -> Any {
        guard let executorId = args["executorId"] as? String,
              executorId == controller.model.description?.executorId else {
            throw ExecutorRefusal("Choose a paired team.")
        }
        let directory = controller.stateDirectory
        switch command {
        case "executor_sync_status":
            return try await json(ExecutorCLI.syncStatus(stateDirectory: directory), controller: controller)
        case "executor_sync_configure":
            guard let input = args["command"] as? [String: Any] else {
                throw ExecutorRefusal(ExecutorCLI.invalidSyncAction)
            }
            return try await json(ExecutorCLI.syncChange(input, stateDirectory: directory), controller: controller)
        case "executor_sync_resolve":
            let invocation = try ExecutorCLI.syncResolve(
                clientConflictId: text(args, "clientConflictId"),
                resolution: text(args, "resolution"),
                stateDirectory: directory
            )
            return try await json(invocation, controller: controller)
        case "executor_sync_trash_list":
            return try await json(ExecutorCLI.syncTrashList(stateDirectory: directory), controller: controller)
        case "executor_sync_trash_restore":
            let entryId = try text(args, "entryId")
            let invocation = try ExecutorCLI.syncRestoreTrash(entryId: entryId, stateDirectory: directory)
            return try await json(invocation, controller: controller)
        case "executor_open_path": try await openSyncLocation(args, controller: controller)
        case "executor_sync_open_nessie":
            guard let address = try await syncState(controller)["manageUrl"] as? String else {
                throw ExecutorRefusal("Nessie has not answered this computer yet. Try again shortly.")
            }
            let url = try ExecutorCLI.syncManageURL(address, isDevelopmentBuild: controller.isDevelopmentBuild)
            NSWorkspace.shared.open(url)
        default: throw ExecutorRefusal("Unknown local executor action.")
        }
        return NSNull()
    }

    private func chooseSyncFolder() -> Any {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.message = "Choose the folder to keep in sync with Nessie"
        panel.directoryURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        if panel.runModal() == .OK, let path = panel.url?.path { return path }
        return NSNull()
    }

    private func syncState(_ controller: ExecutorController) async throws -> [String: Any] {
        let invocation = ExecutorCLI.syncStatus(stateDirectory: controller.stateDirectory)
        guard let state = try await json(invocation, controller: controller) as? [String: Any] else {
            throw ExecutorRefusal("Couldn’t read this team’s sync status.")
        }
        return state
    }

    private func openSyncLocation(_ args: [String: Any], controller: ExecutorController) async throws {
        let location = try text(args, "location")
        let state = try await syncState(controller)
        switch location {
        case "root":
            let folder = try syncFolder(state["root"] as? String, missing: Self.missingSyncFolder)
            NSWorkspace.shared.open(folder)
        case "trash":
            let folder = try syncFolder(state["trashPath"] as? String, missing: "Nothing has been deleted yet.")
            NSWorkspace.shared.open(folder)
        case "file":
            let file = try listedSyncFile(state, relPath: text(args, "relPath"))
            NSWorkspace.shared.activateFileViewerSelecting([file])
        default: throw ExecutorRefusal(ExecutorCLI.invalidSyncAction)
        }
    }

    private func syncFolder(_ path: String?, missing: String) throws -> URL {
        guard let path = path, path.hasPrefix("/"),
              let type = (try? FileManager.default.attributesOfItem(atPath: path))?[.type] as? FileAttributeType,
              type == .typeDirectory else {
            throw ExecutorRefusal(missing)
        }
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    /// A file the CLI lists as an open conflict, reached from the sync root
    /// without passing through a link.
    private func listedSyncFile(_ state: [String: Any], relPath: String) throws -> URL {
        let rows = state["conflicts"] as? [[String: Any]] ?? []
        guard rows.contains(where: { $0["relPath"] as? String == relPath }) else {
            throw ExecutorRefusal("That file is no longer listed.")
        }
        guard let team = state["teamLabel"] as? String else {
            throw ExecutorRefusal("This team’s folder is not ready yet.")
        }
        var url = try syncFolder(state["root"] as? String, missing: Self.missingSyncFolder)
        for segment in try ExecutorCLI.syncSegments(teamLabel: team, relPath: relPath) {
            url.appendPathComponent(segment)
            let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
            guard let type = attributes?[.type] as? FileAttributeType else {
                throw ExecutorRefusal("That file is no longer in the folder.")
            }
            guard type != .typeSymbolicLink else {
                throw ExecutorRefusal("That file is behind a link, so it isn’t shown.")
            }
        }
        return url
    }
}
