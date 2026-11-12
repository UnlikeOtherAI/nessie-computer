import Foundation

/// Starts one team's daemon: `connect`, then `serve`. This synchronous
/// operation runs on the controller's queue.
struct ExecutorDaemonLaunch {
    enum Outcome {
        case started(process: Process, parentLiveness: FileHandle)
        /// Nessie refused `connect`, or a pause it needed first failed. The
        /// refusal is the CLI's own sentence.
        case notConnected(ExecutorRefusal)
        case notSpawned
    }

    let runner: ExecutorProcessRunner
    let stateDirectory: String
    /// The team was stopped in an earlier version: pause it before its daemon
    /// can take any work, and start nothing if the pause cannot be saved.
    let pauseFirst: Bool

    func run() -> Outcome {
        if pauseFirst {
            guard let paused = try? runner.run(ExecutorCLI.pause(stateDirectory: stateDirectory)) else {
                return .notConnected(ExecutorRefusal(.changeRefused))
            }
            guard paused.succeeded else {
                return .notConnected(ExecutorProcessRunner.refusal(from: paused, fallback: Word.changeRefused.text))
            }
        }
        // `connect` first, exactly as the desktop companion does: it is the
        // call that proves Nessie still accepts this computer for the team,
        // and its refusal is what the person needs to read.
        guard let connect = try? runner.run(ExecutorCLI.connect(stateDirectory: stateDirectory)) else {
            return .notConnected(ExecutorRefusal(.connectRefused))
        }
        guard connect.succeeded else {
            return .notConnected(ExecutorProcessRunner.refusal(from: connect, fallback: Word.connectRefused.text))
        }
        guard let spawned = try? runner.spawnDaemon(stateDirectory: stateDirectory) else { return .notSpawned }
        return .started(process: spawned.process, parentLiveness: spawned.parentLiveness)
    }
}
