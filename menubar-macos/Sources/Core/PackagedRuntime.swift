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

/// What a prior daemon's lease file says. A lease that cannot be read the way a
/// daemon writes it is `suspect`, never absent: something holds that path. The
/// decision is a pure function over the lease so the "a dead daemon must not
/// block every later start forever" rule is testable — the exact bug
/// `lease_blocks_start` in the Tauri companion was written to fix.
public enum DaemonLease: Equatable, Sendable {
    case absent
    case held(pid: Int32)
    case suspect
}

public enum DaemonLeaseReader {
    public static let fileName = "daemon.pid"

    public static func read(in stateDirectory: String, fileManager: FileManager = .default) -> DaemonLease {
        let path = (stateDirectory as NSString).appendingPathComponent(fileName)
        guard let attributes = try? fileManager.attributesOfItem(atPath: path) else { return .absent }
        guard (attributes[.type] as? FileAttributeType) == .typeRegular else { return .suspect }
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return .suspect }
        guard let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0 else {
            return .suspect
        }
        return .held(pid: pid)
    }
}

public func leaseBlocksStart(_ lease: DaemonLease, daemonIsLive: (Int32) -> Bool) -> Bool {
    switch lease {
    case .absent: return false
    case .suspect: return true
    case let .held(pid): return daemonIsLive(pid)
    }
}
