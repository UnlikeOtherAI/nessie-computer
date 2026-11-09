import Combine
import Foundation
import OSLog
import SwiftUI

/// Every team on this Mac, one controller each. Nothing here is "selected":
/// the menu speaks about all teams at once, and every action names its team.
///
/// While this app is installed it runs every team on this Mac, including the
/// ones `nessie-computer connect` adds to the command line's folder while the
/// app is open: the command line hands them over rather than starting them
/// itself, so no team ever has two owners.
@MainActor
final class ExecutorConnections: ObservableObject {
    @Published private(set) var controllers: [ExecutorController]
    /// What the update helper needs from the owner: a restart, or approval in Login Items.
    @Published var updateAttention: ComputerUpdateAttention?
    private let isDevelopmentBuild: Bool
    private var observations: Set<AnyCancellable> = []
    private var discoveryTimer: Timer?
    private var namesTimer: Timer?
    private let namesWork = DispatchQueue(label: "com.unlikeotherai.nessie.executor.menubar.names")
    /// The directory the last Add another team used, so the pairing dialog's
    /// status checks follow that attempt and no other.
    private var connectingDirectory: String?

    init(isDevelopmentBuild: Bool) {
        self.isDevelopmentBuild = isDevelopmentBuild
        let initialControllers: [ExecutorController]
        switch ExecutorPaths.discover(isDevelopmentBuild: isDevelopmentBuild) {
        case let .success(directories):
            initialControllers = directories.map {
                ExecutorController(isDevelopmentBuild: isDevelopmentBuild, stateDirectory: $0)
            }
        case let .failure(refusal):
            initialControllers = [ExecutorController(
                isDevelopmentBuild: isDevelopmentBuild,
                stateDirectory: ExecutorPaths.stateDirectory(isDevelopmentBuild: isDevelopmentBuild),
                refusal: refusal
            )]
        }
        controllers = initialControllers
        controllers.forEach(observe)
    }

    private func observe(_ controller: ExecutorController) {
        controller.objectWillChange.merge(with: controller.pairing.objectWillChange)
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &observations)
    }

    /// The paired teams, in a stable order.
    var teams: [ExecutorController] { controllers.filter { $0.model.description != nil } }

    /// A team by its executor id, or by the console's name for one `describe` refuses.
    func team(_ executorId: String) -> ExecutorController? {
        controllers.first {
            $0.model.description?.executorId == executorId || $0.unreadableIdentifier == executorId
        }
    }

    /// `{team} · {organisation}` for every paired team, by executor id.
    func labels() -> [String: String] {
        TeamLabel.labels(for: teams.compactMap { controller in
            guard let description = controller.model.description else { return nil }
            let pairing = controller.pairing.state
            return TeamNames(
                executorId: description.executorId,
                teamName: pairing?.teamName,
                organizationName: pairing?.organizationName,
                apiBaseUrl: pairing?.apiBaseUrl ?? description.apiBaseUrl
            )
        })
    }

    /// The menu, computed from every team's latest reading.
    func menuModel() -> ComputerMenuModel {
        let labels = labels()
        var unreadable = 0
        var unreadableRunning = 0
        var runtimeMissing = false
        var teams: [TeamSnapshot] = []
        for controller in controllers {
            switch controller.model.pairing {
            case .unpaired: continue
            case .unavailable:
                if controller.runtimeMissing { runtimeMissing = true } else { unreadable += 1 }
                if controller.model.daemon != .stopped { unreadableRunning += 1 }
            case let .paired(description):
                teams.append(TeamSnapshot(
                    executorId: description.executorId,
                    label: labels[description.executorId] ?? Word.teamNameUnavailable.text,
                    daemon: controller.model.daemon,
                    connecting: controller.busy,
                    paused: description.isPaused,
                    failure: controller.failure,
                    retrying: controller.retrying,
                    pendingProgramRequests: description.pendingProgramRequests ?? 0,
                    documents: description.folderSync.flatMap(FolderSyncLine.init)
                ))
            }
        }
        return ComputerMenuModel(
            teams: teams, unreadableTeams: unreadable, unreadableRunning: unreadableRunning,
            runtimeMissing: runtimeMissing, updates: updateAttention
        )
    }

    /// "Open Nessie" from the menu: the first team's Nessie, or the hosted one
    /// before any team is connected.
    var nessieConsoleURL: URL {
        (teams.first ?? controllers[0]).nessieConsoleURL()
    }

    var nessieOrigin: String { (teams.first ?? controllers[0]).apiOrigin }

    /// An Add another team attempt whose code is showing, without starting one.
    var openAttempt: ExecutorController? {
        controllers.first { $0.pairing.state?.isPending == true }
    }

    /// Pause or resume one team, or every team (`nil`). Each team's choice is
    /// saved by its own CLI call, so one that fails leaves the others done.
    func setPaused(_ executorId: String?, paused: Bool) async throws {
        let targets = executorId.map { id in teams.filter { $0.model.description?.executorId == id } } ?? teams
        guard !targets.isEmpty else { throw ExecutorRefusal(.teamNotFound) }
        var firstRefusal: Error?
        for controller in targets {
            do { try await controller.setPaused(paused) } catch { firstRefusal = firstRefusal ?? error }
        }
        if let firstRefusal { throw firstRefusal }
    }

    // MARK: - Add another team

    /// The directory a new team connects in: an unfinished one if there is
    /// one, otherwise a fresh directory of its own.
    func prepareConnect() -> ExecutorController {
        if let unfinished = controllers.first(where: { !ExecutorPaths.hasPairingFile($0.stateDirectory) }) {
            connectingDirectory = unfinished.stateDirectory
            return unfinished
        }
        let controller = ExecutorController(
            isDevelopmentBuild: isDevelopmentBuild,
            stateDirectory: ExecutorPaths.newConnectionDirectory(isDevelopmentBuild: isDevelopmentBuild)
        )
        controllers.append(controller)
        observe(controller)
        connectingDirectory = controller.stateDirectory
        controller.start()
        return controller
    }

    /// The attempt the pairing dialog is following: one with a code still
    /// open, else the one Add another team last used, else a fresh one.
    func connectingController() -> ExecutorController {
        controllers.first { ExecutorStateDiscovery.pendingAttemptBlocksStart(in: $0.stateDirectory) }
            ?? controllers.first { $0.stateDirectory == connectingDirectory }
            ?? prepareConnect()
    }

    /// Forgets a team that was disconnected. The list is never empty: an
    /// unpaired placeholder at the preferred directory takes its place.
    func remove(_ controller: ExecutorController) {
        controller.retire()
        LegacyStopPreference.forget(controller.stateDirectory)
        controllers.removeAll { $0 === controller }
        if controllers.isEmpty {
            let placeholder = ExecutorController(
                isDevelopmentBuild: isDevelopmentBuild,
                stateDirectory: ExecutorPaths.stateDirectory(isDevelopmentBuild: isDevelopmentBuild)
            )
            controllers.append(placeholder)
            observe(placeholder)
            placeholder.start()
        }
    }

    func start() {
        controllers.forEach { $0.start() }
        discoveryTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.adoptNewTeams() }
        }
        refreshTeamNames()
        namesTimer = Timer.scheduledTimer(withTimeInterval: 60 * 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshTeamNames() }
        }
    }

    /// Team names (`docs/team-names.md`): one `team-names` call for every team
    /// on this Mac, at launch and every hour, which saves each team's label in
    /// its folder. Each team's pairing status then reads that label again, so
    /// the menu, notifications and the window follow a rename. A read that
    /// fails leaves every saved name as it was, and says why in this app's log.
    func refreshTeamNames() {
        guard let runner = controllers.lazy.compactMap(\.runner).first else { return }
        let invocation = ExecutorCLI.teamNames(stateDirectories: controllers.map(\.stateDirectory))
        let settled = controllers.filter { $0.pairing.state?.isPending != true }
        namesWork.async {
            Self.logTeamNames(Result { try runner.run(invocation) })
            Task { @MainActor in settled.forEach { $0.pairing.restore() } }
        }
    }

    private nonisolated static let namesLog = Logger(
        subsystem: "com.unlikeotherai.nessie.executor.menubar", category: "team-names"
    )

    private nonisolated static func logTeamNames(_ outcome: Result<ExecutorProcessRunner.Completion, Error>) {
        switch outcome {
        case let .success(completion) where completion.succeeded:
            TeamNamesFailures.lines(in: completion.standardError).forEach {
                namesLog.error("\($0, privacy: .public)")
            }
        case .success:
            namesLog.error("team names were not refreshed: the command refused.")
        case .failure:
            namesLog.error("team names were not refreshed: the command did not start.")
        }
    }

    /// Starts a team that appeared in a state folder since the last look.
    func adoptNewTeams() {
        guard case let .success(found) = ExecutorPaths.discover(isDevelopmentBuild: isDevelopmentBuild) else { return }
        let known = controllers.map(\.stateDirectory)
        for directory in ExecutorStateDiscovery.unclaimedTeams(in: found, known: known) {
            let controller = ExecutorController(isDevelopmentBuild: isDevelopmentBuild, stateDirectory: directory)
            controllers.append(controller)
            observe(controller)
            controller.start()
        }
    }

    func refresh() { controllers.forEach { $0.refresh() } }

    /// The helper installs this app's newer runtime only while no team process
    /// runs, and tries for about a minute after it starts. The teams stop, the
    /// helper restarts, and they start again on whatever runtime is installed
    /// once it reports this app's version or two minutes pass.
    func holdTeams(until version: String, restartingHelper restart: () async -> Void) async {
        ComputerUpdateService.holdingTeams = true
        for controller in controllers { _ = await controller.stopDaemonWithoutBlocking() }
        await restart()
        for _ in 0..<40 {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            let status = try? await ExecutorUpdateControl.run(["operation": "status"])
            if status?["installedVersion"] as? String == version { break }
        }
        ComputerUpdateService.holdingTeams = false
        controllers.forEach { $0.refresh(startWhenPaired: true) }
    }

    func shutdown() {
        discoveryTimer?.invalidate()
        discoveryTimer = nil
        namesTimer?.invalidate()
        namesTimer = nil
        controllers.forEach { $0.shutdown() }
    }
}
