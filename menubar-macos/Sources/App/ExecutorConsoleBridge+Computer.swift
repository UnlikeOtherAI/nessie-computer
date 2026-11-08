import AppKit

/// The commands about the whole computer: Pause all, the work agents do here
/// (`ExecutorConsoleBridge+Work.swift`), settings, logs and the native pickers.
extension ExecutorConsoleBridge {
    /// The answer when `command` is one of these; `nil` when it is a team's.
    func invokeComputer(_ command: String, args: [String: Any]) async throws -> Any? {
        switch command {
        case "executor_view": return view()
        case "executor_set_paused":
            guard let paused = args["paused"] as? Bool else { throw ExecutorRefusal(.invalidRequest) }
            // `null` (or no id) means every team: Pause all.
            try await connections.setPaused(args["executorId"] as? String, paused: paused)
            return view()
        case "executor_program_requests", "executor_answer_program_request",
             "executor_sessions", "executor_stop_session":
            return try await invokeWork(command, args: args)
        case "executor_open_logs": DaemonLog.open()
        case "executor_open_nessie": try await openNessie(args)
        case "executor_update_setup":
            guard args.isEmpty else { throw ExecutorRefusal("update.coordinator_unavailable") }
            // One button: set the helper up, or restart one that is stuck.
            if ComputerUpdateHealth.shared.stuck {
                try await ComputerUpdateService.restart(requested: true)
                ComputerUpdateHealth.shared.reset()
                return ComputerUpdateService.unavailableStatus() ?? ComputerUpdateService.restartingStatus()
            }
            try ComputerUpdateService.prepare(requested: true)
            return try await ExecutorUpdateControl.run(["operation": "status"])
        case "executor_update_control":
            guard let request = args["request"] as? [String: Any] else {
                throw ExecutorRefusal("update.coordinator_unavailable")
            }
            return try await ExecutorUpdateControl.run(request)
        case "executor_chatgpt_usage":
            if let url = URL(string: "https://chatgpt.com/settings/usage") { NSWorkspace.shared.open(url) }
        case "executor_choose_folder": return chooseFolder()
        case "executor_sync_pick_folder": return chooseSyncFolder()
        case "executor_copy_code": try copyCode(args)
        case "executor_autostart", "executor_set_autostart": return try autostart(command, args: args)
        case "executor_auto_restart", "executor_set_auto_restart": return try autoRestart(command, args: args)
        default: return nil
        }
        return NSNull()
    }

    /// "Open Nessie" opens the Nessie a team is paired with: the named team's,
    /// or, while a pairing code is up, that attempt's with the code filled in.
    /// The hosted Nessie opens in its desktop app when that is installed and
    /// there is no code to carry.
    private func openNessie(_ args: [String: Any]) async throws {
        let origin: String
        var code: String?
        if args["computer"] as? Bool == true, let executorId = args["executorId"] as? String {
            // That team's own computer page in Nessie; only the browser can
            // open a page by its path.
            NSWorkspace.shared.open(try team(args).nessieConsoleURL(computerId: executorId))
            return
        }
        if args["executorId"] != nil {
            origin = try team(args).apiOrigin
        } else if let attempt = connections.openAttempt {
            origin = attempt.apiOrigin
            code = attempt.pairing.state?.code
        } else if let requested = args["apiBaseUrl"] as? String {
            origin = try ApprovedAPIOrigin.approve(requested, isDevelopmentBuild: AppBuild.isDevelopment).get()
        } else {
            origin = connections.nessieOrigin
        }
        if code == nil, ApprovedAPIOrigin.isHostedNessie(origin), let app = NessieDesktop.installedURL() {
            _ = try await NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
            return
        }
        NSWorkspace.shared.open(ApprovedAPIOrigin.consoleURL(
            forAPIOrigin: origin, isDevelopmentBuild: AppBuild.isDevelopment, pairingCode: code
        ))
    }

    private func autostart(_ command: String, args: [String: Any]) throws -> Any {
        if command == "executor_set_autostart" {
            guard let enabled = args["enabled"] as? Bool else { throw ExecutorRefusal(.invalidRequest) }
            if let refusal = LaunchAtLogin.set(enabled) { throw refusal }
            return NSNull()
        }
        return ["enabled": LaunchAtLogin.isEnabled]
    }

    private func autoRestart(_ command: String, args: [String: Any]) throws -> Any {
        if command == "executor_set_auto_restart" {
            guard let enabled = args["enabled"] as? Bool else { throw ExecutorRefusal(.invalidRequest) }
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

    private func chooseSyncFolder() -> Any {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.message = Word.documentsFolderPrompt.text
        panel.directoryURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        if panel.runModal() == .OK, let path = panel.url?.path { return path }
        return NSNull()
    }

    private func copyCode(_ args: [String: Any]) throws {
        let code = try text(args, "code")
        guard code.utf8.count == 8, code.utf8.allSatisfy({ (48...57).contains($0) }) else {
            throw ExecutorRefusal(.invalidRequest)
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
    }
}
