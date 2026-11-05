import Foundation

/// Starts one connection's daemon: `connect`, then `serve`. This synchronous
/// operation runs on the controller's queue.
struct ExecutorDaemonLaunch {
    enum Outcome {
        case started(process: Process, parentLiveness: FileHandle)
        /// Nessie refused `connect`; the refusal is the remedy a person needs.
        case notConnected(ExecutorRefusal)
        case notSpawned
    }

    private static let unconfirmed = "Confirm this executor's fingerprint in Nessie before starting its daemon."

    let runner: ExecutorProcessRunner
    let stateDirectory: String

    func run() -> Outcome {
        // `connect` first, exactly as the desktop companion does: it is the
        // call that proves somebody confirmed this executor's fingerprint in
        // Nessie, and its refusal is the remedy a person needs.
        guard let connect = try? runner.run(ExecutorCLI.connect(stateDirectory: stateDirectory)) else {
            return .notConnected(ExecutorRefusal(Self.unconfirmed))
        }
        guard connect.succeeded else {
            return .notConnected(ExecutorProcessRunner.refusal(from: connect, fallback: Self.unconfirmed))
        }
        guard let spawned = try? runner.spawnDaemon(stateDirectory: stateDirectory) else { return .notSpawned }
        return .started(process: spawned.process, parentLiveness: spawned.parentLiveness)
    }
}
