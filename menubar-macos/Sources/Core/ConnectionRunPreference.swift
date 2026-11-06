import Foundation

/// A local switch is intent, not pairing or credential authority.
enum ConnectionRunPreference {
    private static func key(_ directory: String) -> String { "executor.connection.running.\(directory)" }
    static func wanted(_ directory: String, defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: key(directory)) as? Bool ?? true
    }
    static func set(_ wanted: Bool, for directory: String, defaults: UserDefaults = .standard) {
        defaults.set(wanted, forKey: key(directory))
    }
}
