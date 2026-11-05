import Foundation

/// How long to wait before starting a connection that stopped without being
/// asked to: from five seconds, doubling to five minutes, and back to five
/// seconds once a connection has stayed up for the longest wait. The same waits
/// the Windows service and tray use for their own connections.
public enum RestartBackoff {
    public static let initial: TimeInterval = 5
    public static let maximum: TimeInterval = 300

    /// The wait before this restart, and the wait to use after it.
    public static func waits(previous: TimeInterval?, ran: TimeInterval) -> (wait: TimeInterval, next: TimeInterval) {
        let wait = ran >= maximum ? initial : (previous ?? initial)
        return (wait, min(wait * 2, maximum))
    }
}

/// When a connection that stopped without being asked to is next started:
/// one pending restart at a time, its wait growing by `RestartBackoff`.
public struct RestartSchedule {
    public private(set) var dueAt: Date?
    private var nextWait: TimeInterval?

    public init() {}

    /// Schedules the restart after a daemon that ran for `ran` stopped.
    public mutating func schedule(ran: TimeInterval, now: Date = Date()) {
        let waits = RestartBackoff.waits(previous: nextWait, ran: ran)
        nextWait = waits.next
        dueAt = now.addingTimeInterval(waits.wait)
    }

    /// Whether a scheduled restart is due. A due restart is taken, so it fires once.
    public mutating func takeDue(now: Date = Date()) -> Bool {
        guard let dueAt, now >= dueAt else { return false }
        self.dueAt = nil
        return true
    }

    /// A person stopped the connection, so nothing restarts it and the next
    /// stop starts the waits over.
    public mutating func cancel() {
        dueAt = nil
        nextWait = nil
    }
}
