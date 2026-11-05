import Foundation

/// The daemon states this app can be in. `stopping` is not the app's own child
/// but a lease in the state directory held by a process that is still alive —
/// the same fact `daemon_status` reads in the Tauri companion.
public enum DaemonState: String, Equatable, Sendable {
    case stopped
    case running
    case stopping
    /// Paired, but nobody has confirmed the fingerprint in Nessie yet, so
    /// `connect` refuses and the daemon cannot start.
    case awaitingConfirmation
}

/// Everything the status item knows, replaced wholesale on every refresh.
///
/// An executor this Mac cannot describe is a *state* here rather than an
/// absence: an icon that silently kept its last green pixel while the runtime
/// was refusing to start would be the worst outcome available, which is the
/// lesson `executor/tray-windows/src-tauri/src/state.rs` was written after.
public struct MenuModel: Equatable, Sendable {
    public enum Pairing: Equatable, Sendable {
        /// The packaged runtime is missing, or `describe` refused. The reason is
        /// the CLI's own, never a substitute.
        case unavailable(String)
        case unpaired
        case paired(ExecutorDescription)
    }

    public var pairing: Pairing
    public var daemon: DaemonState

    public init(pairing: Pairing, daemon: DaemonState) {
        self.pairing = pairing
        self.daemon = daemon
    }

    public var description: ExecutorDescription? {
        if case let .paired(description) = pairing { return description }
        return nil
    }
}

/// What the icon says. Three states, because a person glances at the menu bar
/// rather than reading it: nothing is working for you, something is working for
/// you, or something needs you.
public enum MenuIcon: Equatable, Sendable {
    case stopped
    case running
    case needsAttention
}

/// Amber beats green beats grey: the icon reports the most demanding thing that
/// is true right now. Paired-but-stopped reads the same as nothing paired,
/// deliberately — stopping the daemon on purpose must not light the menu bar up.
/// Folder sync that needs the person (a conflict, held deletions, a missing
/// folder, an Allow in Nessie) is amber too, whichever team it is on.
public func menuIcon(for model: MenuModel, syncNeedsYou: Bool = false) -> MenuIcon {
    if syncNeedsYou { return .needsAttention }
    switch model.pairing {
    case .unavailable:
        return .needsAttention
    case .unpaired:
        return .stopped
    case .paired:
        switch model.daemon {
        case .stopping, .awaitingConfirmation:
            return .needsAttention
        case .running:
            return .running
        case .stopped:
            return .stopped
        }
    }
}

/// The disabled first line of the menu. It says what the icon means, because a
/// shape alone cannot name a remedy.
public func menuHeader(for model: MenuModel) -> String {
    switch model.pairing {
    case let .unavailable(reason):
        return "Nessie Executor — \(reason)"
    case .unpaired:
        return "Nessie Executor — nothing paired"
    case .paired:
        switch model.daemon {
        case .running:
            return "Nessie Executor — running"
        case .stopped:
            return "Nessie Executor — stopped"
        case .stopping:
            return "Nessie Executor — stopping"
        case .awaitingConfirmation:
            return "Nessie Executor — finish pairing in Settings"
        }
    }
}

/// Whether the menu's Start line is offered. Starting is refused for exactly the
/// reasons the header already names, so the menu never offers an action whose
/// only outcome is an error sheet.
public func startIsAvailable(for model: MenuModel) -> Bool {
    guard case .paired = model.pairing else { return false }
    return model.daemon == .stopped || model.daemon == .awaitingConfirmation
}

public func stopIsAvailable(for model: MenuModel) -> Bool {
    model.daemon == .running
}

/// Quit says what it does to the daemon. Unlike the Windows tray, whose service
/// keeps running after the tray closes, this daemon is the app's own child held
/// alive by a pipe — quitting the app *is* stopping the executor, and a Quit
/// that did not say so would be the single most surprising thing here.
public func quitLabel(for model: MenuModel) -> String {
    model.daemon == .running
        ? "Quit Nessie Executor (stops the running executor)"
        : "Quit Nessie Executor"
}
