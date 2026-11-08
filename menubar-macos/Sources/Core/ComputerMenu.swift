import Foundation

/// What the menu bar icon says. A person glances at it rather than reading it:
/// nothing is working for you, something is, or something needs you.
public enum MenuIcon: Equatable, Sendable {
    case idle
    case working
    case needsYou
}

/// The "Needs you" line: one sentence and the exact place that settles it —
/// a console section, or, when `confirmExecutorId` is set, that team's
/// computer page in Nessie, where its owner confirms this computer again.
public struct NeedsYouItem: Equatable, Sendable {
    public let title: String
    public let target: ConsoleTarget
    public let confirmExecutorId: String?

    public init(title: String, target: ConsoleTarget, confirmExecutorId: String? = nil) {
        self.title = title
        self.target = target
        self.confirmExecutorId = confirmExecutorId
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
    /// Teams Nessie names again only after their owner confirms this computer there.
    public let confirmationTeams: [String]
    public let runtimeMissing: Bool
    public let language: NativeLanguage

    public init(
        teams: [TeamSnapshot],
        unreadableTeams: Int = 0,
        confirmationTeams: [String] = [],
        runtimeMissing: Bool = false,
        language: NativeLanguage = .current
    ) {
        self.teams = teams
        self.unreadableTeams = unreadableTeams
        self.confirmationTeams = confirmationTeams
        self.runtimeMissing = runtimeMissing
        self.language = language
    }

    private func say(_ word: Word) -> String { word.text(in: language) }

    /// The disabled first line, about every team at once.
    public var status: String {
        let activities = teams.map(\.activity)
        let working = activities.filter { $0 == .working }.count
        let paused = activities.filter { $0 == .paused }.count
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
        if runtimeMissing {
            items.append(NeedsYouItem(title: say(.needsYouReinstall), target: ConsoleTarget(section: .overview)))
        }
        if unreadableTeams > 0 {
            items.append(NeedsYouItem(title: say(.needsYouUnreadableTeam), target: ConsoleTarget(section: .overview)))
        }
        for executorId in confirmationTeams {
            items.append(NeedsYouItem(
                title: say(.needsYouConfirmComputer),
                target: ConsoleTarget(section: .overview, executorId: executorId),
                confirmExecutorId: executorId
            ))
        }
        for team in teams {
            guard let reason = team.needsYou else { continue }
            let section: ConsoleSection
            switch reason {
            case .programs, .notConnected: section = .overview
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
        return NeedsYouItem(title: say(.needsYouMany(items.count)), target: ConsoleTarget(section: .overview))
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
