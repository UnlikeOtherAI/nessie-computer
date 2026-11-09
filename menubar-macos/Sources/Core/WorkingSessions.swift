import Foundation

/// The team's sessions as `sessions --json` prints them (contract §11.5,
/// `docs/sessions-and-concurrency.md`): one entry per session with work on
/// this computer, its commands beneath. The bridge hands them to the console
/// as they are, with the team's `executorId` added; the console words them.
public enum WorkingSessions {
    /// A session id names a file in the state directory, so only a UUID passes.
    public static func isSessionID(_ value: String) -> Bool {
        value.utf8.count == 36 && UUID(uuidString: value) != nil
    }

    /// The CLI's list with `executorId` on every session. Anything that is not
    /// a list of sessions is refused rather than shown half-read.
    public static func consoleRows(_ data: Data, executorId: String) throws -> [[String: Any]] {
        guard let sessions = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            throw ExecutorRefusal(.invalidRequest)
        }
        return try sessions.map { session in
            guard let id = session["sessionId"] as? String, isSessionID(id), session["commands"] is [Any] else {
                throw ExecutorRefusal(.invalidRequest)
            }
            var row = session
            row["executorId"] = executorId
            return row
        }
    }
}
