import Foundation

/// Each connection keeps its own key and policy beneath the product's state roots.
enum ExecutorPaths {
    static let stateDirectoryOverrideVariable = "NESSIE_EXECUTOR_MENUBAR_STATE_DIR"

    static func stateDirectory(isDevelopmentBuild: Bool) -> String {
        // A development build may be pointed at an already-paired state directory
        // so the app can be driven against a local API. A release never reads
        // this: the state directory of a shipped app is not a thing an
        // environment variable gets to choose.
        if isDevelopmentBuild,
           let override = ProcessInfo.processInfo.environment[stateDirectoryOverrideVariable],
           !override.isEmpty {
            return (override as NSString).expandingTildeInPath
        }
        // Named after the product, never derived from the bundle identifier: an
        // identifier is a packaging decision and changing one must not strand a
        // person's pairing in a folder the new build never looks in.
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support
            .appendingPathComponent("Nessie Executor")
            .appendingPathComponent("executor")
            .path
    }

    static func discover(isDevelopmentBuild: Bool) -> Result<[String], ExecutorRefusal> {
        let preferred = stateDirectory(isDevelopmentBuild: isDevelopmentBuild)
        if isDevelopmentBuild,
           ProcessInfo.processInfo.environment[stateDirectoryOverrideVariable]?.isEmpty == false {
            let root = URL(fileURLWithPath: preferred).deletingLastPathComponent()
                .appendingPathComponent("connections").path
            return ExecutorStateDiscovery.resolve(preferredDirectory: preferred, legacyRoots: [root])
        }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return ExecutorStateDiscovery.resolve(preferredDirectory: preferred, legacyRoots: [
            support.appendingPathComponent("Nessie Executor/connections").path,
            support.appendingPathComponent("com.unlikeotherai.nessie.desktop/executors").path,
            support.appendingPathComponent("com.unlikeotherai.nessie.executor.menubar/executors").path,
            (NSHomeDirectory() as NSString).appendingPathComponent(".local/state/nessie-executor")
        ])
    }

    /// The file `pair` writes. Its presence is the difference between "nobody
    /// has paired this Mac" and "something is wrong with a pairing that exists",
    /// and those two need different words. The file is never opened here.
    static func hasPairingFile(_ directory: String) -> Bool {
        FileManager.default.fileExists(
            atPath: (directory as NSString).appendingPathComponent("executor-state.json")
        )
    }

    static func newConnectionDirectory(isDevelopmentBuild: Bool) -> String {
        let preferred = URL(fileURLWithPath: stateDirectory(isDevelopmentBuild: isDevelopmentBuild))
        return preferred.deletingLastPathComponent()
            .appendingPathComponent("connections").appendingPathComponent(UUID().uuidString).path
    }

    /// Owner-only, created before anything is written into it.
    static func prepare(_ directory: String) throws {
        try FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
    }
}
