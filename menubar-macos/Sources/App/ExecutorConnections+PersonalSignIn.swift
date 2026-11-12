import Foundation

extension ExecutorConnections {
    /// Idle app-owned stdio connections leave through their normal shutdown
    /// before native credential admission. Running commands are never stopped.
    /// The CLI still proves custody; the app cannot grant it by holding teams.
    func withPersonalSignIn(_ work: () async throws -> Data) async throws -> Data {
        guard ComputerRuntimeGate.holds.beginPersonalSignIn() else {
            throw ExecutorRefusal(.planCheckPending)
        }
        defer {
            ComputerRuntimeGate.holds.endPersonalSignIn()
            controllers.forEach { $0.refresh(startWhenPaired: true) }
        }
        for controller in teams {
            guard let id = controller.model.description?.executorId else { continue }
            // An unreadable or active session keeps the daemon untouched. The
            // native operation supplies its public refusal and recovery state.
            guard let sessions = try? await controller.fetchSessions(executorId: id), sessions.isEmpty else {
                return try await work()
            }
        }
        for controller in controllers {
            guard await controller.stopDaemonWithoutBlocking() else { return try await work() }
        }
        let deadline = Date().addingTimeInterval(20)
        while controllers.contains(where: \.daemonLeaseHeld), Date() < deadline {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        return try await work()
    }
}
