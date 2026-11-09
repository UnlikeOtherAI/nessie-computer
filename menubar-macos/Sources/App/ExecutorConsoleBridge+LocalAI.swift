import Foundation

/// The AI tab's **On this computer** rows: Claude Code and Codex, their
/// accounts and each team's Make available switch, read and changed through
/// the team's CLI (contract §12). A change is saved in the team's state folder
/// and the running daemon applies it without a restart.
extension ExecutorConsoleBridge {
    func invokeLocalAI(_ command: String, args: [String: Any], controller: ExecutorController) async throws -> Any {
        let invocation = try LocalAIControl.invocation(
            command: command, args: args, stateDirectory: controller.stateDirectory
        )
        return try await json(invocation, controller: controller)
    }
}
