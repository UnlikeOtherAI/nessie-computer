import Combine
import Foundation
import SwiftUI

/// One controller per account: selecting a view never stops another connection.
@MainActor
final class ExecutorConnections: ObservableObject {
    @Published private(set) var controllers: [ExecutorController]
    @Published var selectedDirectory: String
    private let isDevelopmentBuild: Bool
    private var observations: Set<AnyCancellable> = []

    var selected: ExecutorController {
        controllers.first { $0.stateDirectory == selectedDirectory } ?? controllers[0]
    }

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
        selectedDirectory = initialControllers[0].stateDirectory
        controllers.forEach(observe)
    }

    private func observe(_ controller: ExecutorController) {
        controller.objectWillChange.merge(with: controller.pairing.objectWillChange)
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &observations)
    }

    func label(_ controller: ExecutorController) -> String {
        let pairing = controller.pairing.state
        let name = [pairing?.machineName, pairing?.connectionName].compactMap { $0 }.joined(separator: " · ")
        let server = pairing?.apiBaseUrl ?? controller.model.description?.apiBaseUrl
        return server.map { "\(name) · \($0)" } ?? "New team"
    }

    func add() {
        if let unfinished = controllers.first(where: {
            !ExecutorPaths.hasPairingFile($0.stateDirectory)
        }) {
            selectedDirectory = unfinished.stateDirectory
            return
        }
        let controller = ExecutorController(
            isDevelopmentBuild: isDevelopmentBuild,
            stateDirectory: ExecutorPaths.newConnectionDirectory(isDevelopmentBuild: isDevelopmentBuild)
        )
        controllers.append(controller)
        observe(controller)
        selectedDirectory = controller.stateDirectory
        controller.start()
    }

    /// Forgets a connection whose team was removed. The list is never empty:
    /// an unpaired placeholder at the preferred directory takes its place.
    func remove(_ controller: ExecutorController) {
        controller.retire()
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
        if !controllers.contains(where: { $0.stateDirectory == selectedDirectory }) {
            selectedDirectory = controllers[0].stateDirectory
        }
    }

    func start() { controllers.forEach { $0.start() } }
    func shutdown() { controllers.forEach { $0.shutdown() } }
}
