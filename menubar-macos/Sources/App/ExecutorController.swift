import AppKit
import Combine
import Foundation

/// One team on this Mac: its state directory, its daemon and its latest reading.
///
/// Every paired team's daemon runs while the app does. There is no Stop: an
/// owner keeps agents out with Pause, which the daemon enforces and which
/// therefore survives every start this class makes — at launch, after a
/// crash and after an update.
@MainActor
final class ExecutorController: ObservableObject {
    @Published private(set) var model = ConnectionModel(pairing: .unpaired, daemon: .stopped)
    /// The failure that last stopped this team, as it arrived. The console
    /// translates it; it clears when the team next connects.
    @Published private(set) var failure: TeamFailure?
    @Published private(set) var busy = false
    @Published private(set) var programRequests: [ProgramRequest] = []
    let pairing: ExecutorPairingController

    let isDevelopmentBuild: Bool
    let stateDirectory: String
    let runtime: Result<PackagedRuntime, ExecutorRefusal>
    private let work = DispatchQueue(label: "com.unlikeotherai.nessie.executor.menubar.cli")
    private var daemon: SupervisedDaemon?
    private var refreshTimer: Timer?
    private var startAfterRefresh = false
    /// A daemon that stopped, or a start that failed, is tried again when
    /// `restarts` is due, if `AutoRestart` is on.
    private var restarts = RestartSchedule()
    /// Disconnected: nothing starts this team again.
    private var retired = false
    private var checkingPersonalUpdate = false
    private var readingRequests = false

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
        if ExecutorPaths.hasPairingFile(stateDirectory) {
            model = ConnectionModel(pairing: .unavailable(Word.existingTeamNeedsAttention.text), daemon: .stopped)
        }
        pairing.onPaired = { [weak self] in self?.refresh(startWhenPaired: true) }
        pairing.onChanged = { [weak self] in self?.refresh() }
        pairing.beforeReplace = { [weak self] in
            guard let self, self.model.daemon != .stopping else { return false }
            return self.stopDaemon()
        }
    }

    /// A failure is not yet the owner's while a restart is about to retry it.
    var retrying: Bool { restarts.dueAt != nil }

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

    // MARK: - Reading

    func start() {
        pairing.restore()
        refresh(startWhenPaired: true)
        // The daemon's own lease and a child that exited on its own are both
        // facts this app has to notice without being clicked, so the icon can
        // never be showing something that stopped being true.
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func refresh(startWhenPaired: Bool = false) {
        if startWhenPaired { startAfterRefresh = true }
        Task { await reload() }
    }

    /// One `describe`, applied, and whatever follows from it. Awaited by the
    /// bridge so the view it answers with is the state after a change.
    func reload() async {
        // Every `describe` is a runtime process, and the helper installs this
        // app's runtime only while none runs; the hold ends with a refresh.
        guard !ComputerUpdateService.holdingTeams else { return }
        guard let runner else {
            if case let .failure(refusal) = runtime {
                model = ConnectionModel(pairing: .unavailable(refusal.message), daemon: .stopped)
            }
            return
        }
        let stateDirectory = self.stateDirectory
        let reading: Reading = await withCheckedContinuation { continuation in
            work.async {
                let completion = try? runner.run(ExecutorCLI.describe(stateDirectory: stateDirectory))
                let description = completion.flatMap { completion -> ExecutorDescription? in
                    guard completion.succeeded else { return nil }
                    return try? ExecutorDescription.decode(Data(completion.standardOutput.utf8))
                }
                continuation.resume(returning: Reading(
                    description: description, completion: completion,
                    lease: DaemonLeaseReader.read(in: stateDirectory)
                ))
            }
        }
        guard !retired else { return }
        apply(description: reading.description, completion: reading.completion, lease: reading.lease)
        startIfRequested()
        readProgramRequests()
    }

    /// One `describe` and the lease beside it, read together off the main thread.
    private struct Reading {
        let description: ExecutorDescription?
        let completion: ExecutorProcessRunner.Completion?
        let lease: DaemonLease
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
            guard ExecutorPaths.hasPairingFile(stateDirectory) else {
                model = ConnectionModel(pairing: .unpaired, daemon: .stopped)
                return
            }
            // A team `describe` refuses can still be running — this app's own
            // daemon, or one another process started — and the menu says so.
            model = ConnectionModel(
                pairing: .unavailable(completion.map {
                    ExecutorProcessRunner.refusal(from: $0, fallback: Word.existingTeamNeedsAttention.text).message
                } ?? PackagedRuntime.missingRefusal),
                daemon: currentDaemonState(lease: lease)
            )
            return
        }
        model = ConnectionModel(pairing: .paired(description), daemon: currentDaemonState(lease: lease))
    }

    private func currentDaemonState(lease: DaemonLease) -> DaemonState {
        if let daemon, daemon.isRunning { return .running }
        if let exited = daemon {
            // The child exited on its own; stop holding a handle to it.
            self.daemon = nil
            if !exited.signalled {
                failure = TeamFailure(code: nil, message: Word.teamStoppedUnexpectedly.text)
                scheduleRestart(ran: Date().timeIntervalSince(exited.startedAt))
            }
        }
        if leaseBlocksStart(lease, daemonIsLive: { kill($0, 0) == 0 }) { return .stopping }
        return .stopped
    }

    // MARK: - Program requests

    private func readProgramRequests() {
        guard !readingRequests, runner != nil, let description = model.description else { return }
        guard (description.pendingProgramRequests ?? 0) > 0 else {
            if !programRequests.isEmpty { programRequests = [] }
            return
        }
        readingRequests = true
        Task {
            defer { readingRequests = false }
            if let requests = try? await fetchProgramRequests() { programRequests = requests }
        }
    }

    func fetchProgramRequests() async throws -> [ProgramRequest] {
        let data = try await requireRunner().output(ExecutorCLI.programRequests(stateDirectory: stateDirectory))
        return try ProgramRequest.decodeList(data)
    }

    /// The team's sessions and their commands, read fresh from its CLI.
    func fetchSessions(executorId: String) async throws -> [[String: Any]] {
        let data = try await requireRunner().output(ExecutorCLI.sessions(stateDirectory: stateDirectory))
        return try WorkingSessions.consoleRows(data, executorId: executorId)
    }

    /// The owner's Stop for one of this team's sessions: its daemon ends that
    /// session's work and tells Nessie. Nothing else in the team stops.
    func stopSession(_ sessionId: String) async throws {
        _ = try await requireRunner().output(ExecutorCLI.stopSession(id: sessionId, stateDirectory: stateDirectory))
    }

    /// The owner's answer, given only on this computer. `always` adds the
    /// program to this team's rules through the CLI's own writer.
    func answer(_ requestId: String, _ answer: ProgramRequestAnswer) async throws {
        let invocation = try ExecutorCLI.answerProgramRequest(
            id: requestId, answer: answer, stateDirectory: stateDirectory
        )
        _ = try await requireRunner().output(invocation)
        programRequests.removeAll { $0.id == requestId }
        await reload()
    }

    // MARK: - Pause

    /// Saves the owner's pause in this team's state directory and tells its
    /// daemon, which stays connected and refuses new work. Nothing here stops
    /// or starts the daemon.
    func setPaused(_ paused: Bool) async throws {
        let invocation = paused
            ? ExecutorCLI.pause(stateDirectory: stateDirectory)
            : ExecutorCLI.resume(stateDirectory: stateDirectory)
        _ = try await requireRunner().output(invocation)
        // The owner has now said what they want for this team.
        LegacyStopPreference.forget(stateDirectory)
        await reload()
    }

    // MARK: - Remedies

    func apply(_ remedy: NativeRemedy) async {
        switch remedy {
        case .openNessie:
            NSWorkspace.shared.open(nessieConsoleURL())
        case .restartExecutor:
            failure = nil
            if await stopDaemonWithoutBlocking() { startDaemon() }
        case .reProposePolicy:
            await reProposePolicy()
        }
    }

    /// Offers the settings this Mac already has as a *newer* revision, until
    /// Nessie stops calling them a rollback. Nothing about what the team may
    /// do changes: each proposal restates what `describe` just reported.
    private func reProposePolicy() async {
        guard let runner, let description = model.description else { return }
        let proposal = ExecutorPolicyReproposal(
            runner: runner, description: description, stateDirectory: stateDirectory
        )
        guard await stopDaemonWithoutBlocking() else { return }
        failure = nil
        busy = true
        let result = await withCheckedContinuation { continuation in
            work.async { continuation.resume(returning: proposal.run()) }
        }
        busy = false
        switch result {
        case .success: startDaemon()
        case let .failure(refusal):
            failure = TeamFailure(classifying: refusal.message)
            refresh()
        }
    }

    // MARK: - Supervision

    /// A team process still holds this team's lease: this app's own, or one an
    /// earlier copy of the app started, which can outlive it for a while.
    var daemonLeaseHeld: Bool {
        leaseBlocksStart(DaemonLeaseReader.read(in: stateDirectory), daemonIsLive: { kill($0, 0) == 0 })
    }

    private var pairingBlocksStart: Bool {
        pairing.busy || pairing.state?.isPending == true
            || ExecutorStateDiscovery.pendingAttemptBlocksStart(in: stateDirectory)
    }

    private func startIfRequested() {
        guard !retired, model.description != nil, model.daemon == .stopped, !busy, !pairingBlocksStart else { return }
        guard isDevelopmentBuild || ComputerUpdateService.factoryReady else { return }
        if restarts.takeDue() {
            guard AutoRestart.isEnabled else { return }
            startDaemon()
            return
        }
        guard startAfterRefresh else { return }
        startAfterRefresh = false
        startDaemon()
    }

    /// Schedules the next automatic start. With `AutoRestart` off the team
    /// stays not connected, with its reason, until the owner restarts it.
    private func scheduleRestart(ran: TimeInterval) {
        guard !retired, AutoRestart.isEnabled else { return }
        restarts.schedule(ran: ran)
    }

    func startDaemon() {
        guard !retired, !busy, !pairingBlocksStart, model.description != nil, daemon?.isRunning != true else { return }
        guard let runner else {
            failure = TeamFailure(code: nil, message: PackagedRuntime.missingRefusal)
            return
        }
        guard isDevelopmentBuild || ComputerUpdateService.factoryReady, !ComputerUpdateService.holdingTeams,
              !leaseBlocksStart(DaemonLeaseReader.read(in: stateDirectory), daemonIsLive: { kill($0, 0) == 0 }) else {
            // The update factory is not ready yet, the helper is installing this
            // app's runtime, or a prior daemon is still tearing down (an update
            // restart looks like this): try at the next reading.
            startAfterRefresh = true
            return
        }
        let launch = ExecutorDaemonLaunch(
            runner: runner, stateDirectory: stateDirectory,
            pauseFirst: LegacyStopPreference.needsPause(stateDirectory)
        )
        busy = true
        work.async { [weak self] in
            let outcome = launch.run()
            Task { @MainActor [weak self] in self?.finishStart(outcome, pausedFirst: launch.pauseFirst) }
        }
    }

    private func finishStart(_ outcome: ExecutorDaemonLaunch.Outcome, pausedFirst: Bool) {
        busy = false
        switch outcome {
        case let .notConnected(refusal):
            failure = TeamFailure(classifying: refusal.message)
            if FailureClassifier.isRetryable(refusal.message) { scheduleRestart(ran: 0) }
            refresh()
        case .notSpawned:
            failure = TeamFailure(code: nil, message: Word.teamNotStarted.text)
            scheduleRestart(ran: 0)
        case let .started(process, parentLiveness):
            if pausedFirst { LegacyStopPreference.forget(stateDirectory) }
            let spawned = SupervisedDaemon(process: process, parentLiveness: parentLiveness)
            daemon = spawned
            failure = nil
            // Disconnected while it was starting: it is tracked until it
            // exits, so a stop that waited for this start waits for it too.
            if retired { spawned.signalStop() }
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

    /// The same stop, awaited without holding the main thread.
    func stopDaemonWithoutBlocking() async -> Bool {
        while busy { try? await Task.sleep(nanoseconds: 50_000_000) }
        guard let stopping = beginStop() else { return true }
        await stopping.waitForExitWithoutBlocking()
        return finishStop(stopping)
    }

    private func beginStop() -> SupervisedDaemon? {
        startAfterRefresh = false
        restarts.cancel()
        daemon?.signalStop()
        return daemon
    }

    private func finishStop(_ stopping: SupervisedDaemon) -> Bool {
        refresh()
        guard !stopping.isRunning else {
            failure = TeamFailure(code: nil, message: Word.teamStillStopping.text)
            return false
        }
        daemon = nil
        return true
    }

    /// Disconnecting: stop watching, and start nothing again.
    func retire() {
        retired = true
        refreshTimer?.invalidate()
        refreshTimer = nil
        restarts.cancel()
        pairing.shutdown()
    }

    /// Quitting stops the daemon. Closing the parent-liveness pipe would do it on
    /// its own, but the app waits for the teardown rather than exiting while
    /// guests are still running. A pause is left exactly as it was.
    func shutdown() {
        pairing.shutdown()
        guard daemon != nil else { return }
        _ = stopDaemon()
        daemon?.parentLiveness.closeFile()
        daemon = nil
    }
}
