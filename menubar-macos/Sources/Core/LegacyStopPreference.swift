import Foundation

/// The Stop switch earlier versions kept per team, read once and turned into Pause.
///
/// A team somebody stopped on purpose meant "agents may not use this computer".
/// Stop no longer exists: every paired team's daemon runs, and Pause is how an
/// owner keeps agents out. So a team found stopped is paused through the CLI
/// before its daemon starts, and only then is the old switch forgotten. A
/// team that was running, or never had the switch, is left alone.
public enum LegacyStopPreference {
    private static func key(_ directory: String) -> String { "executor.connection.running.\(directory)" }

    /// Whether this team was stopped on purpose and has not been paused for it yet.
    public static func needsPause(_ directory: String, defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: key(directory)) as? Bool == false
    }

    /// Forgets the old switch once the pause it stood for is saved, or once the
    /// team is gone. A switch that was on is forgotten the same way.
    public static func forget(_ directory: String, defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key(directory))
    }
}
