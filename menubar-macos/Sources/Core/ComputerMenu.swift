import Foundation

/// What the menu bar icon says. A person glances at it rather than reading it:
/// nothing is working for you, something is, or something needs you.
public enum MenuIcon: Equatable, Sendable {
    case idle
    case working
    case needsYou
}

/// The "Needs you" line: one sentence and the place that settles it — the
/// window (its Needs you strip shows on every tab) or a console section.
public struct NeedsYouItem: Equatable, Sendable {
    public let title: String
    public let target: ConsoleTarget
    /// The line opens System Settings → Login Items instead of the window.
    public let opensLoginItems: Bool

    public init(title: String, target: ConsoleTarget, opensLoginItems: Bool = false) {
        self.title = title
        self.target = target
        self.opensLoginItems = opensLoginItems
    }
}

/// Pause and Resume. One team gets one line; several get a submenu with
/// "All teams" first and then one line per team, checked when paused.
public enum PauseMenu: Equatable, Sendable {
    public struct Line: Equatable, Sendable {
        public let title: String
        /// `nil` means every team.
        public let executorId: String?
        public let checked: Bool
        /// What choosing the line does.
        public let pause: Bool
    }

    case unavailable(title: String)
    case single(Line)
    case submenu(title: String, lines: [Line])
}

/// The whole menu, computed from every team at once. No team is "selected":
/// each line is either about all of them or names the one it is about.
public struct ComputerMenuModel: Equatable, Sendable {
    public let teams: [TeamSnapshot]
    /// Directories that hold a pairing this Mac cannot read.
    public let unreadableTeams: Int
    public let runtimeMissing: Bool
    /// The update helper can't be reached or refuses, so no team can start.
    public let updatesStuck: Bool
    /// macOS won't run the update helper until the owner allows it in Login Items.
    public let updatesNeedApproval: Bool
    public let language: NativeLanguage

    public init(
        teams: [TeamSnapshot],
        unreadableTeams: Int = 0,
        runtimeMissing: Bool = false,
        updatesStuck: Bool = false,
        updatesNeedApproval: Bool = false,
        language: NativeLanguage = .current
    ) {
        self.teams = teams
        self.unreadableTeams = unreadableTeams
        self.runtimeMissing = runtimeMissing
        self.updatesStuck = updatesStuck
        self.updatesNeedApproval = updatesNeedApproval
        self.language = language
    }

    private func say(_ word: Word) -> String { word.text(in: language) }

    /// The disabled first line, about every team at once.
    public var status: String {
        let activities = teams.map(\.activity)
        let working = activities.filter { $0 == .working }.count
        let paused = activities.filter { $0 == .paused }.count
        // Said before "No team connected": the teams are there but can't start.
        if updatesStuck { return say(.statusUpdatesStuck) }
        if teams.isEmpty { return say(.statusNoTeam) }
        if paused == teams.count { return say(.statusPaused) }
        if working > 0 {
            return say(.statusWorking(working: working, paused: paused, notConnected: teams.count - working - paused))
        }
        if activities.contains(.connecting) { return say(.statusConnecting) }
        return say(.statusNotConnected)
    }

    /// Everything that needs the owner, most urgent first.
    public var needsYouItems: [NeedsYouItem] {
        var items: [NeedsYouItem] = []
        if updatesNeedApproval {
            items.append(NeedsYouItem(
                title: say(.needsYouUpdatesApproval), target: ConsoleTarget(), opensLoginItems: true
            ))
        }
        if updatesStuck {
            items.append(NeedsYouItem(title: say(.needsYouUpdatesStuck), target: ConsoleTarget()))
        }
        if runtimeMissing {
            items.append(NeedsYouItem(title: say(.needsYouReinstall), target: ConsoleTarget()))
        }
        if unreadableTeams > 0 {
            items.append(NeedsYouItem(title: say(.needsYouUnreadableTeam), target: ConsoleTarget()))
        }
        for team in teams {
            guard let reason = team.needsYou else { continue }
            let section: ConsoleSection?
            switch reason {
            case .programs, .notConnected: section = nil
            default: section = .documents
            }
            items.append(NeedsYouItem(
                title: say(.needsYou(team: team.label, reason: reason)),
                target: ConsoleTarget(section: section, executorId: team.executorId)
            ))
        }
        return items
    }

    /// The one "Needs you" line the menu shows, when there is anything.
    public var needsYou: NeedsYouItem? {
        let items = needsYouItems
        guard items.count > 1 else { return items.first }
        return NeedsYouItem(title: say(.needsYouMany(items.count)), target: ConsoleTarget())
    }

    /// Amber only for what needs the owner; any working team is "working";
    /// nothing connected, everything paused and connecting are all idle.
    public var icon: MenuIcon {
        if needsYou != nil { return .needsYou }
        return teams.contains { $0.activity == .working } ? .working : .idle
    }

    public var iconDescription: String {
        switch icon {
        case .idle: return say(.iconIdle)
        case .working: return say(.iconWorking)
        case .needsYou: return say(.iconNeedsYou)
        }
    }

    public var toolTip: String {
        [status, needsYou?.title].compactMap { $0 }.joined(separator: "\n")
    }

    public var pauseMenu: PauseMenu {
        let allPaused = !teams.isEmpty && teams.allSatisfy(\.paused)
        let title = say(allPaused ? .resume : .pause)
        guard let only = teams.first else { return .unavailable(title: say(.pause)) }
        guard teams.count > 1 else {
            return .single(PauseMenu.Line(
                title: title, executorId: only.executorId, checked: false, pause: !only.paused
            ))
        }
        let all = PauseMenu.Line(title: say(.allTeams), executorId: nil, checked: allPaused, pause: !allPaused)
        return .submenu(title: title, lines: [all] + teams.map {
            PauseMenu.Line(title: $0.label, executorId: $0.executorId, checked: $0.paused, pause: !$0.paused)
        })
    }

    /// Quitting stops every daemon this app supervises, so while any team is
    /// working Quit says what that means for its agents.
    public var quitTitle: String {
        say(teams.contains { $0.activity == .working } ? .quitWhileWorking : .quit)
    }
}
