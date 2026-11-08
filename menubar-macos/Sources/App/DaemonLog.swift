import AppKit

/// Where each team's daemon writes what it prints: one owner-only file per
/// team under `~/Library/Logs/Nessie Computer`, which Settings → Help opens.
///
/// A file past its limit is kept as `.previous.log` when the daemon next
/// starts, so a log is bounded by two files rather than growing forever, and
/// the run that went wrong is still there to read after a restart.
enum DaemonLog {
    private static let limit = 5 * 1024 * 1024

    static var folder: URL {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs")
            .appendingPathComponent("Nessie Computer")
    }

    /// The team's log, open for appending; `nil` when it cannot be written,
    /// in which case the daemon's output is discarded as it always was.
    static func handle(for stateDirectory: String) -> FileHandle? {
        let manager = FileManager.default
        guard (try? manager.createDirectory(
            at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
        )) != nil else { return nil }
        let name = URL(fileURLWithPath: stateDirectory).lastPathComponent
        let file = folder.appendingPathComponent("\(name).log")
        if let size = (try? manager.attributesOfItem(atPath: file.path))?[.size] as? Int, size > limit {
            let previous = folder.appendingPathComponent("\(name).previous.log")
            try? manager.removeItem(at: previous)
            try? manager.moveItem(at: file, to: previous)
        }
        if !manager.fileExists(atPath: file.path) {
            manager.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        guard let handle = try? FileHandle(forWritingTo: file) else { return nil }
        _ = try? handle.seekToEnd()
        return handle
    }

    /// Opens the folder in Finder, creating it first so the button never
    /// opens nothing.
    static func open() {
        try? FileManager.default.createDirectory(
            at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
        )
        NSWorkspace.shared.open(folder)
    }
}
