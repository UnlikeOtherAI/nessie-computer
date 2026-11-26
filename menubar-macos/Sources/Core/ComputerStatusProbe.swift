import Foundation

/// Settings and the monitor share the active read. After completion the next
/// caller reads the helper again, including after a failed or interrupted read.
@MainActor final class ComputerStatusProbe {
    private var active: Task<Data, Error>?

    func read(_ operation: @escaping @MainActor () async throws -> Data) async throws -> Data {
        if let active { return try await active.value }
        let task = Task { @MainActor in
            defer { self.active = nil }
            return try await operation()
        }
        active = task
        return try await task.value
    }
}
