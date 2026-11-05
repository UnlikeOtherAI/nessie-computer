import Foundation

/// The daemon one connection spawned. It is asked to stop at most once — a
/// second SIGTERM could cut its graceful teardown short — and it is never
/// killed: a daemon with guests still tearing down is waited for, so a sandbox
/// is never abandoned half-torn-down.
@MainActor
final class SupervisedDaemon {
    private static let stopDeadline: TimeInterval = 10

    let process: Process
    /// Closing this pipe stops the daemon on its own; see `shutdown`.
    let parentLiveness: FileHandle
    let startedAt = Date()
    /// Whether this daemon was asked to stop, so its exit was not a crash.
    private(set) var signalled = false

    init(process: Process, parentLiveness: FileHandle) {
        self.process = process
        self.parentLiveness = parentLiveness
    }

    var isRunning: Bool { process.isRunning }

    func signalStop() {
        guard process.isRunning, !signalled else { return }
        signalled = true
        kill(process.processIdentifier, SIGTERM)
    }

    /// Waits on the calling thread for the daemon to exit.
    func waitForExit() {
        let deadline = Date().addingTimeInterval(Self.stopDeadline)
        while process.isRunning, Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
    }

    /// The same wait without holding the main thread.
    func waitForExitWithoutBlocking() async {
        let deadline = Date().addingTimeInterval(Self.stopDeadline)
        while process.isRunning, Date() < deadline { try? await Task.sleep(nanoseconds: 50_000_000) }
    }
}
