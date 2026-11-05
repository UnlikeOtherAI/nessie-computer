import Foundation

/// Reconcile an older local policy by reproposing the same permissions at a
/// newer revision. This synchronous operation runs on the controller's queue.
struct ExecutorPolicyReproposal {
    let runner: ExecutorProcessRunner
    let description: ExecutorDescription
    let stateDirectory: String

    /// A stale policy is behind by a handful of revisions, not hundreds.
    private static let attemptCeiling = 25

    func run() -> Result<Void, ExecutorRefusal> {
        var attempts = 0
        var lastRefusal = "Nessie Executor could not propose these settings again."
        while attempts < Self.attemptCeiling {
            attempts += 1
            guard let invocation = try? ExecutorCLI.configure(
                operationKeys: description.policy.operations,
                workspaceFolders: description.reach.folders,
                commandAllowlist: description.policy.permittedPrograms,
                stateDirectory: stateDirectory
            ), let configured = try? runner.run(invocation), configured.succeeded else {
                break
            }
            guard let connected = try? runner.run(ExecutorCLI.connect(stateDirectory: stateDirectory)) else { break }
            if connected.succeeded { return .success(()) }
            lastRefusal = ExecutorProcessRunner.refusal(from: connected, fallback: lastRefusal).message
            // Only a rollback is worth another revision. Other refusals need
            // their own remedy, rather than repeated configuration writes.
            guard ExecutorFailureTranslator.translate(lastRefusal).remedy == .reProposePolicy else { break }
        }
        let message = ExecutorFailureTranslator.translate(lastRefusal).code == "EXECUTOR_DESCRIPTOR_ROLLBACK"
            ? "Nessie still considers this Mac's settings older than the ones it has "
                + "recorded after \(attempts) attempts. Pair this Mac again from Settings."
            : lastRefusal
        return .failure(ExecutorRefusal(message))
    }
}
