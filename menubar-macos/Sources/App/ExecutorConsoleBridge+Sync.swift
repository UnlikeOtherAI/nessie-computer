import AppKit

/// The Documents tab. Every path this window opens is read from the CLI's own
/// `sync status --json`, never taken from the page, and a file is shown
/// selected in Finder rather than opened, because it may be a program.
extension ExecutorConsoleBridge {
    func invokeSync(_ command: String, args: [String: Any], controller: ExecutorController) async throws -> Any {
        let directory = controller.stateDirectory
        switch command {
        case "executor_sync_status":
            return try await json(ExecutorCLI.syncStatus(stateDirectory: directory), controller: controller)
        case "executor_sync_configure":
            guard let input = args["command"] as? [String: Any] else { throw ExecutorRefusal(.invalidRequest) }
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
            let invocation = try ExecutorCLI.syncRestoreTrash(entryId: text(args, "entryId"), stateDirectory: directory)
            return try await json(invocation, controller: controller)
        case "executor_open_path": try await openSyncLocation(args, controller: controller)
        case "executor_sync_open_nessie":
            guard let address = try await syncState(controller)["manageUrl"] as? String else {
                throw ExecutorRefusal(.nessieNotAnswered)
            }
            NSWorkspace.shared.open(
                try ExecutorCLI.syncManageURL(address, isDevelopmentBuild: controller.isDevelopmentBuild)
            )
        default: throw ExecutorRefusal(.invalidRequest)
        }
        return NSNull()
    }

    private func syncState(_ controller: ExecutorController) async throws -> [String: Any] {
        let invocation = ExecutorCLI.syncStatus(stateDirectory: controller.stateDirectory)
        guard let state = try await json(invocation, controller: controller) as? [String: Any] else {
            throw ExecutorRefusal(.documentsStatusUnreadable)
        }
        return state
    }

    private func openSyncLocation(_ args: [String: Any], controller: ExecutorController) async throws {
        let location = try text(args, "location")
        let state = try await syncState(controller)
        switch location {
        case "root":
            NSWorkspace.shared.open(try syncFolder(state["root"] as? String, missing: .documentsFolderMissing))
        case "trash":
            NSWorkspace.shared.open(try syncFolder(state["trashPath"] as? String, missing: .nothingDeleted))
        case "file":
            let file = try listedSyncFile(state, relPath: text(args, "relPath"))
            NSWorkspace.shared.activateFileViewerSelecting([file])
        default: throw ExecutorRefusal(.invalidRequest)
        }
    }

    private func syncFolder(_ path: String?, missing: Word) throws -> URL {
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
            throw ExecutorRefusal(.fileNotListed)
        }
        guard let team = state["teamLabel"] as? String else { throw ExecutorRefusal(.teamFolderNotReady) }
        var url = try syncFolder(state["root"] as? String, missing: .documentsFolderMissing)
        for segment in try ExecutorCLI.syncSegments(teamLabel: team, relPath: relPath) {
            url.appendPathComponent(segment)
            let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
            guard let type = attributes?[.type] as? FileAttributeType else { throw ExecutorRefusal(.fileGone) }
            guard type != .typeSymbolicLink else { throw ExecutorRefusal(.fileBehindLink) }
        }
        return url
    }
}
