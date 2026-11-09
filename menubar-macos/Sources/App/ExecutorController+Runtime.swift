import Foundation

/// The packaged runtime this team runs through, and the Nessie it belongs to.
extension ExecutorController {
    var runner: ExecutorProcessRunner? {
        guard case let .success(runtime) = runtime else { return nil }
        return ExecutorProcessRunner(runtime: runtime, isDevelopmentBuild: isDevelopmentBuild)
    }

    func requireRunner() throws -> ExecutorProcessRunner {
        guard let runner else { throw ExecutorRefusal(PackagedRuntime.missingRefusal) }
        return runner
    }

    var runtimeMissing: Bool {
        if case .failure = runtime { return true }
        return false
    }

    /// Where the pairing panel's choice starts. The CLI validates whatever is
    /// finally sent; this is never what authorizes an origin.
    var defaultAPIOrigin: String { ApprovedAPIOrigin.default(isDevelopmentBuild: isDevelopmentBuild) }

    /// This team's Computers page on the Nessie it is paired with — never a
    /// stranger's console — with the one-shot pairing intent while a code is up.
    func nessieConsoleURL(pairingCode: String? = nil, computerId: String? = nil) -> URL {
        ApprovedAPIOrigin.consoleURL(
            forAPIOrigin: apiOrigin, isDevelopmentBuild: isDevelopmentBuild, pairingCode: pairingCode,
            computerId: computerId
        )
    }

    /// The Nessie this team is paired with, or is pairing with.
    var apiOrigin: String { pairing.state?.apiBaseUrl ?? model.description?.apiBaseUrl ?? defaultAPIOrigin }
}
