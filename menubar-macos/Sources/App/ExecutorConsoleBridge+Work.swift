import Foundation

/// The work agents do on this computer, as the owner sees it on Overview: the
/// program requests waiting for an answer and the sessions agents are working
/// in (contract §11.5). Every list is read fresh from each team's CLI rather
/// than from what the menu last saw.
extension ExecutorConsoleBridge {
    func invokeWork(_ command: String, args: [String: Any]) async throws -> Any {
        switch command {
        case "executor_program_requests":
            return try await programRequests(args["executorId"] as? String)
        case "executor_answer_program_request":
            guard let answer = (args["answer"] as? String).flatMap(ProgramRequestAnswer.init(rawValue:)) else {
                throw ExecutorRefusal(.invalidRequest)
            }
            try await team(args).answer(text(args, "id"), answer)
            return try await programRequests(nil)
        case "executor_sessions":
            return try await sessions(args["executorId"] as? String)
        case "executor_stop_session":
            try await team(args).stopSession(text(args, "sessionId"))
            // The console replaces its whole list with this answer, so it is every team's.
            return try await sessions(nil)
        default:
            throw ExecutorRefusal(.invalidRequest)
        }
    }

    /// The open requests of one team, or of every team.
    private func programRequests(_ executorId: String?) async throws -> [[String: Any]] {
        var rows: [[String: Any]] = []
        for (id, controller) in try teams(executorId) {
            rows += try await controller.fetchProgramRequests().map { $0.consoleRow(executorId: id) }
        }
        return rows
    }

    /// The sessions agents are working in, for one team or for every team.
    private func sessions(_ executorId: String?) async throws -> [[String: Any]] {
        var rows: [[String: Any]] = []
        for (id, controller) in try teams(executorId) {
            rows += try await controller.fetchSessions(executorId: id)
        }
        return rows
    }

    private func teams(_ executorId: String?) throws -> [(String, ExecutorController)] {
        let teams = try executorId.map { [try team(["executorId": $0])] } ?? connections.teams
        return teams.compactMap { controller in (controller.model.description?.executorId).map { ($0, controller) } }
    }
}
