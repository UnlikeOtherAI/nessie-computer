import Foundation

/// Where the bundled CLI and its pinned Node live inside the app.
///
/// `executor/scripts/prepare-runtime.mjs` is the one producer of this layout —
/// the Linux package, the desktop bundle and this app are three callers of one
/// preparation, never three implementations of it — so the names below are read
/// from that script's contract and nothing here lays a file down.
public struct PackagedRuntime: Equatable, Sendable {
    public static let directoryName = "executor-runtime"
    public static let bundleFileName = "nessie-executor.cjs"
    /// POSIX hosts run `nessie-executor-runtime`; the Windows name never occurs in this app.
    public static let nodeFileName = "nessie-executor-runtime"

    public let root: URL

    public init(root: URL) {
        self.root = root
    }

    public var nodeURL: URL { root.appendingPathComponent(PackagedRuntime.nodeFileName) }
    public var bundleURL: URL { root.appendingPathComponent(PackagedRuntime.bundleFileName) }
    public var manifestURL: URL { root.appendingPathComponent("manifest.json") }

    /// Selection only. The fixed native creator proves signatures, root
    /// ownership, immutable files and machine custody before starting Node.
    public func managedHelperURL(
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> URL? {
        // The installed factory selects its own immutable release. App bundles
        // carry the consumer protocol floor, rather than pinning an old runtime.
        let root = URL(fileURLWithPath: "/Library/Application Support/Nessie Executor")
        guard fileExists(root.path) else { return nil }
        let directory = root.appendingPathComponent("current")
        let helper = directory.appendingPathComponent("nessie-executor-native")
        // A partial installed update must fail at its fixed factory, never
        // silently start the older Node bundled in this app instead.
        return helper
    }

    /// The runtime version this app carries, read from its manifest. It only
    /// decides whether to restart the helper; the helper verifies the seal.
    public func executorVersion(read: (URL) -> Data? = { try? Data(contentsOf: $0) }) -> String? {
        guard let data = read(manifestURL), data.count <= 65_536,
              let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return manifest["executorVersion"] as? String
    }

    /// The refusal a person sees when the app was assembled without its runtime.
    /// It names the remedy, because a missing runtime is not transient.
    public static var missingRefusal: String { Word.runtimeMissing.text }

    public static func locate(
        in resourceDirectory: URL?,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> Result<PackagedRuntime, ExecutorRefusal> {
        guard let resourceDirectory else {
            return .failure(ExecutorRefusal(missingRefusal))
        }
        let runtime = PackagedRuntime(root: resourceDirectory.appendingPathComponent(directoryName))
        guard fileExists(runtime.nodeURL.path), fileExists(runtime.bundleURL.path) else {
            return .failure(ExecutorRefusal(missingRefusal))
        }
        return .success(runtime)
    }
}
