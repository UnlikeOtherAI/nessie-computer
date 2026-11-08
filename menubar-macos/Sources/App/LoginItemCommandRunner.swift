import Foundation

/// Carries out a `--login-item` request (`LoginItemCommand`) with the same
/// `LaunchAtLogin` the Settings tab uses, and returns the exit status.
enum LoginItemCommandRunner {
    static func run(_ command: LoginItemCommand) -> Int32 {
        if case let .set(enabled) = command, let refusal = LaunchAtLogin.set(enabled) {
            let needsApproval = refusal == ExecutorRefusal(.loginItemNeedsApproval)
            print(LoginItemCommand.answer(refusal: needsApproval ? "needsApproval" : "failed"))
            return 1
        }
        print(LoginItemCommand.answer(enabled: LaunchAtLogin.isEnabled))
        return 0
    }
}
