import AppKit
import WebKit

/// The window's only door to this computer: the packaged console names a
/// command and public identifiers, and every change reaches the CLI.
///
/// Failures pass through as the CLI wrote them; the console translates them.
/// Refusals this file makes itself are already in the person's language.
@MainActor
final class ExecutorConsoleBridge: NSObject, WKScriptMessageHandlerWithReply {
    let connections: ExecutorConnections
    private let entryURL: URL

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
            replyHandler(nil, Word.onlyLocalWindow.text)
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

    // MARK: - Shared

    /// The team a command names. Every team command names one: there is no
    /// selected team to fall back on.
    func team(_ args: [String: Any]) throws -> ExecutorController {
        guard let identifier = args["executorId"] as? String, let controller = connections.team(identifier) else {
            throw ExecutorRefusal(.teamNotFound)
        }
        return controller
    }

    func text(_ args: [String: Any], _ key: String) throws -> String {
        guard let value = args[key] as? String, !value.isEmpty else { throw ExecutorRefusal(.invalidRequest) }
        return value
    }

    func run(_ invocation: ExecutorCLIInvocation, controller: ExecutorController) async throws -> Data {
        try await controller.requireRunner().output(invocation)
    }

    func json(_ invocation: ExecutorCLIInvocation, controller: ExecutorController) async throws -> Any {
        try JSONSerialization.jsonObject(with: await run(invocation, controller: controller))
    }

    /// Every paired team, with what the Overview needs to say about it. A
    /// failure is the CLI's own sentence; its code is set when this app
    /// recognises it, and the console translates either.
    func view() -> [String: Any] {
        ["kind": "reachable", "executors": connections.controllers.compactMap { controller -> [String: Any]? in
            if case let .unavailable(reason) = controller.model.pairing,
               let identifier = controller.unreadableIdentifier {
                // Paired, but `describe` is refused: listed, so the window is
                // never empty and never offers to pair again. A daemon that is
                // running still counts as working; a stopped one says why. The
                // row takes its executor id back once a reading succeeds.
                var row: [String: Any] = [
                    "executorId": identifier, "daemonStatus": controller.model.daemon.rawValue,
                    "paused": false, "pendingProgramRequests": 0
                ]
                if controller.model.daemon == .stopped { row["failure"] = ["message": reason] }
                return row
            }
            guard let description = controller.model.description else { return nil }
            var row: [String: Any] = [
                "executorId": description.executorId,
                "daemonStatus": controller.model.daemon.rawValue,
                "paused": description.isPaused,
                "pendingProgramRequests": description.pendingProgramRequests ?? 0
            ]
            if let failure = controller.failure {
                var failed: [String: Any] = ["message": failure.message]
                if let code = failure.code { failed["code"] = code }
                row["failure"] = failed
            }
            // The team's saved label (docs/team-names.md), as the menu shows it.
            if let pairing = controller.pairing.state, let organization = pairing.organizationName {
                row["names"] = [
                    "organizationName": organization,
                    "teamName": pairing.teamName.map { $0 as Any } ?? NSNull(),
                    "apiBaseUrl": pairing.apiBaseUrl ?? description.apiBaseUrl
                ] as [String: Any]
            }
            return row
        }]
    }

    // MARK: - Dispatch

    private func invoke(_ command: String, args: [String: Any]) async throws -> Any {
        if command.hasPrefix("executor_pairing_") { return try await pairing(command, args: args) }
        if let answer = try await invokeComputer(command, args: args) { return answer }
        return try await invokeTeam(command, args: args)
    }

    /// The commands that act on one team.
    private func invokeTeam(_ command: String, args: [String: Any]) async throws -> Any {
        let controller = try team(args)
        let directory = controller.stateDirectory
        switch command {
        case "executor_describe":
            return try await json(ExecutorCLI.describe(stateDirectory: directory), controller: controller)
        case "executor_configure": return try await configure(args, controller: controller)
        case "executor_inference_connections":
            guard let operation = args["operation"] as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: operation), data.count <= 16 * 1024 else {
                throw ExecutorRefusal(.invalidRequest)
            }
            let invocation = ExecutorCLIInvocation(
                arguments: ["local-inference", "connections", "--operation-stdin",
                    "--state-dir", controller.stateDirectory], standardInput: data
            )
            return try await json(invocation, controller: controller)
        case "executor_personal_chatgpt":
            guard let operation = args["operation"] as? [String: Any] else { throw ExecutorRefusal(.invalidRequest) }
            let invocation = try PersonalChatgptControl.invocation(
                operation: operation, stateDirectory: controller.stateDirectory
            )
            let runner = try controller.requireRunner()
            let run = {
                try await PersonalChatgptProcess().run(
                    process: runner.process(for: invocation), invocation: invocation
                )
            }
            let data: Data
            if operation["operation"] as? String == "start", operation["acknowledgeHostRestriction"] as? Bool == true {
                data = try await connections.withPersonalSignIn(run)
            } else {
                data = try await run()
            }
            return try JSONSerialization.jsonObject(with: data)
        case "executor_remove": return try await remove(controller)
        case "executor_apply_remedy":
            guard let remedy = (args["remedy"] as? String).flatMap(NativeRemedy.init(rawValue:)) else {
                throw ExecutorRefusal(.invalidRequest)
            }
            await controller.apply(remedy)
            return view()
        case let local where LocalAIControl.commands.contains(local):
            return try await invokeLocalAI(local, args: args, controller: controller)
        case let sync where sync.hasPrefix("executor_sync_") || sync == "executor_open_path":
            return try await invokeSync(sync, args: args, controller: controller)
        default: throw ExecutorRefusal(.invalidRequest)
        }
    }

    /// One saved setting, applied to the running team without stopping it:
    /// the CLI writes the next revision and tells the daemon, which re-signs
    /// and stays connected.
    private func configure(_ args: [String: Any], controller: ExecutorController) async throws -> Any {
        guard let input = args["configurationInput"] as? [String: Any] else { throw ExecutorRefusal(.invalidRequest) }
        let invocation = ExecutorCLIInvocation(
            arguments: ["configure", "--configuration-input-stdin", "--state-dir", controller.stateDirectory],
            standardInput: try JSONSerialization.data(withJSONObject: input)
        )
        _ = try await run(invocation, controller: controller)
        controller.refresh()
        return try await json(ExecutorCLI.describe(stateDirectory: controller.stateDirectory), controller: controller)
    }

    /// Disconnects a team from this Mac. The runtime signs off with Nessie, then
    /// deletes the team's directory; the answer says whether Nessie heard.
    private func remove(_ controller: ExecutorController) async throws -> Any {
        guard await controller.stopDaemonWithoutBlocking() else { throw ExecutorRefusal(.teamStillStopping) }
        controller.pairing.shutdown()
        let result = try await json(
            ExecutorCLI.unpair(stateDirectory: controller.stateDirectory), controller: controller
        )
        connections.remove(controller)
        return ["signedOff": (result as? [String: Any])?["signedOff"] as? Bool == true]
    }

    // MARK: - Add another team

    /// Pairing always happens in a directory of its own, which this app picks;
    /// the page only names the server, and only when the person chose another
    /// one. There is no other option to pass.
    private func pairing(_ command: String, args: [String: Any]) async throws -> Any {
        let controller = command == "executor_pairing_start"
            ? connections.prepareConnect() : connections.connectingController()
        controller.pairing.shutdown()
        let directory = controller.stateDirectory
        // A claim in Nessie completes the pairing; the status check that finds
        // an open attempt paired is the moment its daemon starts.
        let wasPending = ExecutorStateDiscovery.pendingAttemptBlocksStart(in: directory)
        let invocation: ExecutorCLIInvocation
        switch command {
        case "executor_pairing_start":
            let requested = (args["apiBaseUrl"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let origin = try ApprovedAPIOrigin.approve(
                requested ?? controller.defaultAPIOrigin, isDevelopmentBuild: controller.isDevelopmentBuild
            ).get()
            try ExecutorPaths.prepare(directory)
            invocation = try ExecutorCLI.pairingStart(apiBaseUrl: origin, replace: false, stateDirectory: directory)
        case "executor_pairing_cancel": invocation = ExecutorCLI.pairingCancel(stateDirectory: directory)
        case "executor_pairing_status": invocation = ExecutorCLI.pairingStatus(stateDirectory: directory)
        default: throw ExecutorRefusal(.invalidRequest)
        }
        let result = try await json(invocation, controller: controller)
        let paired = (result as? [String: Any])?["status"] as? String == "paired"
        controller.refresh(startWhenPaired: wasPending && paired)
        return result
    }
}
