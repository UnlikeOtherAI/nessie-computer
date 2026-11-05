import Foundation

/// Whether this app starts a connection it runs again after it stops without
/// being asked to. On unless the person turned it off, so an absent value
/// means on.
enum AutoRestart {
    private static let key = "RestartStoppedConnections"

    static var isEnabled: Bool { UserDefaults.standard.object(forKey: key) as? Bool ?? true }

    static func set(_ enabled: Bool) { UserDefaults.standard.set(enabled, forKey: key) }
}
