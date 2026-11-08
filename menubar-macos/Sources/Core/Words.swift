import Foundation

/// The languages Nessie Computer speaks, the same seven as the shared console.
public enum NativeLanguage: String, CaseIterable, Sendable {
    case britishEnglish = "en-GB"
    case americanEnglish = "en"
    case czech = "cs"
    case german = "de"
    case spanish = "es"
    case french = "fr"
    case italian = "it"

    /// The language for a list of preferred languages, best first, resolved the
    /// way macOS resolves the bundle's own `.lproj` folders: `en-AU` finds
    /// British English, `de-AT` finds German, and anything else falls back to
    /// American English, the development language.
    public static func resolve(_ preferences: [String]) -> NativeLanguage {
        let available = allCases.map(\.rawValue)
        let chosen = Bundle.preferredLocalizations(from: available, forPreferences: preferences).first
        return chosen.flatMap(NativeLanguage.init(rawValue:)) ?? .americanEnglish
    }

    public static var current: NativeLanguage { resolve(Locale.preferredLanguages) }
}

/// Why a team needs its owner, as the end of a "Needs you" line.
public enum NeedsYouReason: Equatable, Sendable {
    case programs(Int)
    case documentConflicts(Int)
    case documentsNeedChecking
    case allowDocumentsInNessie
    case allowDocumentsAgain
    case documentsFolderMissing
    case diskFull
    case notConnected
}

/// Every sentence this app shows a person, outside the shared console.
///
/// Each language answers every case in an exhaustive `switch`, so a word added
/// here without a translation does not compile. The console has its own words;
/// these are the menu bar's, the notifications' and the refusals the bridge
/// hands the console to show beside a control.
public enum Word: Equatable, Sendable {
    case statusNoTeam
    case statusPaused
    case statusWorking(working: Int, paused: Int, notConnected: Int)
    case statusConnecting
    case statusNotConnected
    case needsYou(team: String, reason: NeedsYouReason)
    case needsYouReinstall
    case needsYouUnreadableTeam
    case needsYouMany(Int)
    case pause
    case resume
    case allTeams
    case openComputer
    case addThisComputer
    case openNessie
    case quit
    case quitWhileWorking
    case iconIdle
    case iconWorking
    case iconNeedsYou
    case teamNameUnavailable
    case programRequestTitle(agent: String?, program: String)
    case programRequestBody(team: String, command: String)
    case allowOnce
    case alwaysAllow(program: String)
    case dontAllow
    case onlyLocalWindow
    case invalidRequest
    case teamNotFound
    case runtimeMissing
    case changeRefused
    case teamStillStopping
    case teamNotStarted
    case teamStoppedUnexpectedly
    case connectRefused
    case loginItemNeedsApproval
    case loginItemFailed
    case documentsFolderMissing
    case nothingDeleted
    case fileNotListed
    case teamFolderNotReady
    case fileGone
    case fileBehindLink
    case nessieNotAnswered
    case documentsStatusUnreadable
    case addressNotOpened
    case documentsFolderPrompt
    case addressNeedsHTTPS
    case addressHasCredentials
    case addressHasPath
    case addressMustBeHTTPS
    case pairingFailed
    case pairingCleanupRequired
    case pairingCodeMissing
    case existingTeamsUnreadable
    case existingTeamNeedsAttention
    case settingsStillOlder(attempts: Int)
    case settingsNotProposed
    case planNameRequired
    case planCheckFailed
    case planCheckPending
}

public extension Word {
    func text(in language: NativeLanguage) -> String {
        switch language {
        case .britishEnglish, .americanEnglish: return EnglishWords.text(self)
        case .czech: return CzechWords.text(self)
        case .german: return GermanWords.text(self)
        case .spanish: return SpanishWords.text(self)
        case .french: return FrenchWords.text(self)
        case .italian: return ItalianWords.text(self)
        }
    }

    /// In the language macOS chose for this app.
    var text: String { text(in: .current) }
}

/// A refusal in the person's language.
public extension ExecutorRefusal {
    init(_ word: Word) {
        self.init(word.text)
    }
}
