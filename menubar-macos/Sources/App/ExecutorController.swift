import AppKit
import Combine
import Foundation

@MainActor
final class ExecutorController: ObservableObject {
    @Published private(set) var model = MenuModel(pairing: .unpaired, daemon: .stopped)
    /// The last failure a person has not yet dismissed, translated into what it
    /// means and what they can do about it. Never swallowed, and never shown as
    /// the API's own sentence alone — see `ExecutorFailure`.
    @Published var failure: ExecutorFailure?
    @Published private(set) var busy = false
    let pairing: ExecutorPairingController

    let isDevelopmentBuild: Bool
    let stateDirectory: String
    private let runtime: Result<PackagedRuntime, ExecutorRefusal>
    private let work = DispatchQueue(label: "com.unlikeotherai.nessie.executor.menubar.cli")
    private var daemon: SupervisedDaemon?
    private var refreshTimer: Timer?
    private var startAfterRefresh = false
    /// Whether the person last asked for this connection on. A stop clears it,
    /// so a start already on its way ends as soon as its daemon exists.
    var wantsDaemon = false
    /// A daemon that stopped without being asked to is started again when
    /// `restarts` is due, if `AutoRestart` is on.
    private var restarts = RestartSchedule()
    /// The start in flight is an automatic restart, so a failed one is retried.
    private var restarting = false
    private var checkingPersonalUpdate = false

    /// The ordinary status command resumes only a profile that intentionally
    /// drained for an update, retaining its original registration and consent.
    func resumePersonalUpdate() {
        guard !checkingPersonalUpdate, model.description != nil, let runner else { return }
        checkingPersonalUpdate = true
        Task {
            defer { checkingPersonalUpdate = false }
            let invocation = ExecutorCLIInvocation(
                arguments: ["personal-chatgpt-local", "--operation-stdin", "--state-dir", stateDirectory],
                standardInput: Data("{\"operation\":\"status\"}".utf8)
            )
            _ = try? await PersonalChatgptProcess().run(
                process: runner.process(for: invocation), invocation: invocation
            )
        }
    }

    init(isDevelopmentBuild: Bool, stateDirectory: String, refusal: ExecutorRefusal? = nil) {
        self.isDevelopmentBuild = isDevelopmentBuild
        self.stateDirectory = stateDirectory
        self.runtime = refusal.map { .failure($0) } ?? PackagedRuntime.locate(in: Bundle.main.resourceURL)
        let runtime = try? self.runtime.get()
        self.pairing = ExecutorPairingController(
            runner: runtime.map { ExecutorProcessRunner(runtime: $0, isDevelopmentBuild: isDevelopmentBuild) },
            stateDirectory: stateDirectory,
            isDevelopmentBuild: isDevelopmentBuild
        )
        pairing.onPaired = { [weak self] in self?.refresh(startWhenPaired: true) }
        pairing.onChanged = { [weak self] in self?.refresh() }
        pairing.beforeReplace = { [weak self] in
            guard let self, self.model.daemon != .stopping else { return false }
            return self.stopDaemon()
        }
    }

    private var runner: ExecutorProcessRunner? {
        guard case let .success(runtime) = runtime else { return nil }
        return ExecutorProcessRunner(runtime: runtime, isDevelopmentBuild: isDevelopmentBuild)
    }

    /// Where the pairing panel's choice starts. A person changes it there; this
    /// is never what authorizes an origin — `ApprovedAPIOrigin.approve` is.
    var defaultAPIOrigin: String { ApprovedAPIOrigin.default(isDevelopmentBuild: isDevelopmentBuild) }

    // MARK: - Reading

    func start() {
        pairing.restore()
        refresh(startWhenPaired: ConnectionRunPreference.wanted(stateDirectory))
        // The daemon's own lease and a child that exited on its own are both
        // facts this app has to notice without being clicked, so the icon can
        // never be showing something that stopped being true.
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func refresh(startWhenPaired: Bool = false) {
        if startWhenPaired { startAfterRefresh = true }
        guard let runner else {
            if case let .failure(refusal) = runtime {
                model = MenuModel(pairing: .unavailable(refusal.message), daemon: .stopped)
            }
            return
        }
        let stateDirectory = self.stateDirectory
        let invocation = ExecutorCLI.describe(stateDirectory: stateDirectory)
        work.async { [weak self] in
            let completion = try? runner.run(invocation)
            let description = completion.flatMap { completion -> ExecutorDescription? in
                guard completion.succeeded else { return nil }
                return try? ExecutorDescription.decode(Data(completion.standardOutput.utf8))
            }
            let lease = DaemonLeaseReader.read(in: stateDirectory)
            Task { @MainActor [weak self] in
                self?.apply(description: description, completion: completion, lease: lease)
                self?.startIfRequested()
            }
        }
    }

    private func startIfRequested() {
        guard model.description != nil, model.daemon == .stopped, !busy, !pairingBlocksStart else { return }
        if restarts.takeDue() {
            guard wantsDaemon, AutoRestart.isEnabled else { return }
            restarting = true
            startDaemon()
            return
        }
        guard startAfterRefresh else { return }
        startAfterRefresh = false
        startDaemon()
    }

    /// Schedules the next automatic start of a daemon the person still wants
    /// running. With `AutoRestart` off it stays stopped until they start it.
    private func scheduleRestart(ran: TimeInterval) {
        guard wantsDaemon, AutoRestart.isEnabled else { return }
        restarts.schedule(ran: ran)
    }

    private func apply(
        description: ExecutorDescription?,
        completion: ExecutorProcessRunner.Completion?,
        lease: DaemonLease
    ) {
        guard let description else {
            // No pairing file is the ordinary state of a Mac nobody has paired,
            // not a failure. Only its *presence* is checked — never its contents:
            // the moment this app read that file it would become a second
            // interpretation of the policy the daemon enforces.
            model = MenuModel(
                pairing: ExecutorPaths.hasPairingFile(stateDirectory)
                    ? .unavailable(
                        completion.map {
                            ExecutorProcessRunner.refusal(
                                from: $0,
                                fallback: "this executor's local state could not be read"
                            ).message
                        } ?? "the packaged executor runtime could not be run"
                    )
                    : .unpaired,
                daemon: .stopped
            )
            return
        }
        model = MenuModel(pairing: .paired(description), daemon: currentDaemonState(lease: lease))
    }

    private func currentDaemonState(lease: DaemonLease) -> DaemonState {
        if let daemon, daemon.isRunning { return .running }
        if let exited = daemon {
            // The child exited on its own; stop holding a handle to it.
            self.daemon = nil
            if !exited.signalled { scheduleRestart(ran: Date().timeIntervalSince(exited.startedAt)) }
        }
        if leaseBlocksStart(lease, daemonIsLive: { kill($0, 0) == 0 }) { return .stopping }
        return .stopped
    }

    /// Every failure reaches a person through here, so there is one place that
    /// decides what a refusal means and exactly one banner shape it can take.
    func fail(_ message: String) {
        failure = ExecutorFailureTranslator.translate(message)
    }

    /// The remedy a banner offers, performed.
    func apply(_ remedy: ExecutorFailure.Remedy) {
        failure = nil
        switch remedy {
        case .none:
            return
        case .openNessie:
            NSWorkspace.shared.open(nessieExecutorsURL)
        case .restartExecutor:
            if stopDaemon() { startDaemon() }
        case .reProposePolicy:
            reProposePolicy()
        }
    }

    /// "Open Nessie" has to open the Nessie this Mac is paired with. A Mac
    /// paired with DeepTest or with somebody's own server that was sent to
    /// nessie.works would be a remedy pointing at a stranger's console.
    var nessieExecutorsURL: URL {
        ApprovedAPIOrigin.consoleURL(
            forAPIOrigin: pairing.state?.apiBaseUrl ?? model.description?.apiBaseUrl ?? defaultAPIOrigin,
            isDevelopmentBuild: isDevelopmentBuild
        )
    }

    /// Offers the settings this Mac already has as a *newer* revision, until
    /// Nessie stops calling them a rollback.
    ///
    /// Nessie refuses a revision lower than the highest it has recorded, and its
    /// refusal does not say which number that is — so the only way back is to
    /// propose the next one and ask again. Nothing about what the executor may
    /// do changes: each proposal restates the operations, workspace and
    /// permitted commands `describe` just reported, and every one of them still
    /// lands as a revision a person reviews in Nessie.
    private func reProposePolicy() {
        guard let runner, let description = model.description else {
            fail("Pair this Mac with Nessie before changing its local policy.")
            return
        }
        let proposal = ExecutorPolicyReproposal(
            runner: runner, description: description, stateDirectory: stateDirectory
        )
        let wasRunning = model.daemon == .running
        if wasRunning { _ = stopDaemon() }
        busy = true
        work.async { [weak self] in
            let result = proposal.run()
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.busy = false
                switch result {
                case .success:
                    self.failure = nil
                    if wasRunning { self.startDaemon() } else { self.refresh() }
                case let .failure(refusal):
                    self.fail(refusal.message)
                    self.refresh()
                }
            }
        }
    }

    // MARK: - Supervision

    private var pairingBlocksStart: Bool {
        pairing.busy || pairing.state?.isAttemptOpen == true
            || ExecutorStateDiscovery.pendingAttemptBlocksStart(in: stateDirectory)
    }

    func startDaemon() {
        // An automatic restart that fails is tried again after a longer wait;
        // a start the person asked for reports its failure and stops there.
        let automatic = restarting
        restarting = false
        guard !busy, !pairingBlocksStart else { return }
        guard let runner else {
            fail(PackagedRuntime.missingRefusal)
            return
        }
        guard model.description != nil else {
            fail("Pair this Mac with Nessie before starting its executor.")
            return
        }
        if daemon?.isRunning == true { return }
        wantsDaemon = true
        ConnectionRunPreference.set(true, for: stateDirectory)
        if leaseBlocksStart(DaemonLeaseReader.read(in: stateDirectory), daemonIsLive: { kill($0, 0) == 0 }) {
            fail("The prior local daemon is still tearing down. Wait for it to finish before starting again.")
            if automatic { scheduleRestart(ran: 0) }
            return
        }
        let launch = ExecutorDaemonLaunch(runner: runner, stateDirectory: stateDirectory)
        busy = true
        work.async { [weak self] in
            let outcome = launch.run()
            Task { @MainActor [weak self] in self?.finishStart(outcome, automatic: automatic) }
        }
    }

    private func finishStart(_ outcome: ExecutorDaemonLaunch.Outcome, automatic: Bool) {
        busy = false
        switch outcome {
        case let .notConnected(refusal):
            fail(refusal.message)
            if automatic { scheduleRestart(ran: 0) }
            refresh()
        case .notSpawned:
            fail("Nessie Executor could not start the executor daemon.")
            if automatic { scheduleRestart(ran: 0) }
        case let .started(process, parentLiveness):
            let spawned = SupervisedDaemon(process: process, parentLiveness: parentLiveness)
            daemon = spawned
            // Turned off while it was starting: it is tracked until it exits, so a
            // stop that waited for this start also waits for the daemon to end.
            if !wantsDaemon { spawned.signalStop() }
            refresh()
        }
    }

    /// Asks the daemon to stop and waits, then refuses if it is still tearing
    /// down; see `SupervisedDaemon`. Quitting uses this blocking form.
    @discardableResult
    func stopDaemon() -> Bool {
        guard let stopping = beginStop() else { return true }
        stopping.waitForExit()
        return finishStop(stopping)
    }

    /// The same stop for the console, awaited without holding the main thread,
    /// so the window stays usable while a saved setting restarts the connection.
    func stopDaemonWithoutBlocking() async -> Bool {
        guard let stopping = beginStop() else { return true }
        await stopping.waitForExitWithoutBlocking()
        return finishStop(stopping)
    }

    private func beginStop() -> SupervisedDaemon? {
        ConnectionRunPreference.set(false, for: stateDirectory)
        startAfterRefresh = false
        wantsDaemon = false
        restarts.cancel()
        daemon?.signalStop()
        return daemon
    }

    private func finishStop(_ stopping: SupervisedDaemon) -> Bool {
        refresh()
        guard !stopping.isRunning else {
            fail("The executor is still stopping. Nessie Executor will not force-kill a sandbox daemon.")
            return false
        }
        daemon = nil
        return true
    }

    /// A removed connection stops watching a directory that no longer exists.
    func retire() {
        refreshTimer?.invalidate()
        refreshTimer = nil
        pairing.shutdown()
    }

    /// Quitting stops the daemon. Closing the parent-liveness pipe would do it on
    /// its own, but the app waits for the teardown rather than exiting while
    /// guests are still running.
    func shutdown() {
        pairing.shutdown()
        guard daemon != nil else { return }
        let wanted = ConnectionRunPreference.wanted(stateDirectory)
        defer { ConnectionRunPreference.set(wanted, for: stateDirectory) }
        _ = stopDaemon()
        daemon?.parentLiveness.closeFile()
        daemon = nil
    }
}
