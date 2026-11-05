import Combine
import Foundation

/// Owns the lifetime of one pairing attempt. Every transition comes from the
/// packaged runtime; the UI never reads keys or edits pending or paired state.
@MainActor
final class ExecutorPairingController: ObservableObject {
    @Published private(set) var state: ExecutorPairing?
    @Published private(set) var busy = false
    @Published private(set) var failure: String?

    var onPaired: (() -> Void)?
    var onChanged: (() -> Void)?
    var beforeStart: (() -> Bool)?
    var beforeReplace: (() -> Bool)?
    private let runner: ExecutorProcessRunner?
    private let stateDirectory: String
    private let isDevelopmentBuild: Bool
    private let work = DispatchQueue(label: "com.unlikeotherai.nessie.executor.menubar.pairing")
    private var pollTimer: Timer?

    init(runner: ExecutorProcessRunner?, stateDirectory: String, isDevelopmentBuild: Bool) {
        self.runner = runner
        self.stateDirectory = stateDirectory
        self.isDevelopmentBuild = isDevelopmentBuild
    }

    func restore() {
        perform(ExecutorCLI.pairingStatus(stateDirectory: stateDirectory))
    }

    func begin(origin: String, replace: Bool) {
        guard !busy else { return }
        guard beforeStart?() != false else { return }
        guard !replace || beforeReplace?() == true else { return }
        do {
            let approved = try ApprovedAPIOrigin.approve(origin, isDevelopmentBuild: isDevelopmentBuild).get()
            try ExecutorPaths.prepare(stateDirectory)
            perform(try ExecutorCLI.pairingStart(
                apiBaseUrl: approved,
                replace: replace,
                stateDirectory: stateDirectory
            ))
        } catch {
            failure = "Nessie could not start pairing. Check the address, then try again."
        }
    }

    func cancel() {
        perform(ExecutorCLI.pairingCancel(stateDirectory: stateDirectory))
    }

    func shutdown() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func perform(_ invocation: ExecutorCLIInvocation) {
        guard !busy else { return }
        guard let runner else {
            failure = "Nessie Executor needs to be reinstalled before this Mac can pair."
            return
        }
        busy = true
        failure = nil
        work.async { [weak self] in
            let result: Result<ExecutorPairing, ExecutorRefusal>
            do {
                let completion = try runner.run(invocation)
                let output = Data(completion.standardOutput.utf8)
                result = completion.succeeded
                    ? .success(try ExecutorPairing.decode(output))
                    : .failure(ExecutorRefusal(ExecutorPairing.failureMessage(from: output)))
            } catch {
                result = .failure(ExecutorRefusal(ExecutorPairing.genericFailureMessage))
            }
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.busy = false
                switch result {
                case let .success(state):
                    // The claim in Nessie completed the pairing: the poll that
                    // first reads it paired starts the daemon.
                    let completed = self.state?.isPending == true && state.isPaired
                    self.state = state
                    self.updatePolling()
                    self.onChanged?()
                    if completed { self.onPaired?() }
                case let .failure(refusal):
                    self.failure = refusal.message
                }
            }
        }
    }

    private func updatePolling() {
        pollTimer?.invalidate()
        pollTimer = nil
        guard state?.isPending == true else { return }
        pollTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.restore() }
        }
    }
}
