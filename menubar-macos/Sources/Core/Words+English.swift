import Foundation

/// British and American English share every sentence here.
enum EnglishWords {
    private static func count(_ value: Int, _ one: String, _ many: String) -> String {
        "\(value) \(value == 1 ? one : many)"
    }

    private static func reason(_ reason: NeedsYouReason) -> String {
        switch reason {
        case let .programs(value):
            return value == 1 ? "a program asks to run" : "\(value) programs ask to run"
        case let .documentConflicts(value): return count(value, "document conflict", "document conflicts")
        case .documentsNeedChecking: return "documents need checking"
        case .allowDocumentsInNessie: return "allow documents in Nessie"
        case .allowDocumentsAgain: return "allow documents in Nessie again"
        case .documentsFolderMissing: return "the documents folder is missing"
        case .diskFull: return "the disk is full"
        case .notConnected: return "not connected"
        }
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    static func text(_ word: Word) -> String {
        switch word {
        case .statusNoTeam: return "No team connected"
        case .statusPaused: return "Paused"
        case let .statusWorking(working, paused, notConnected):
            var parts = ["Working for \(count(working, "team", "teams"))"]
            if paused > 0 { parts.append("\(paused) paused") }
            if notConnected > 0 { parts.append("\(notConnected) not connected") }
            return parts.joined(separator: " · ")
        case .statusConnecting: return "Connecting…"
        case .statusNotConnected: return "Not connected — open Nessie Computer"
        case .statusUpdatesStuck: return "Updates are stuck — teams can’t start"
        case let .needsYou(team, why): return "Needs you: \(team) — \(reason(why))"
        case .needsYouReinstall: return "Needs you: reinstall Nessie Computer"
        case .needsYouUnreadableTeam: return "Needs you: a team on this Mac can’t be read"
        case .needsYouUpdatesStuck: return "Needs you: updates are stuck — open Nessie Computer"
        case let .needsYouMany(value): return "Needs you: \(value) things — open Nessie Computer"
        case .pause: return "Pause"
        case .resume: return "Resume"
        case .allTeams: return "All teams"
        case .openComputer: return "Open Nessie Computer…"
        case .addAnotherTeam: return "Add another team…"
        case .openNessie: return "Open Nessie"
        case .quit: return "Quit Nessie Computer"
        case .quitWhileWorking: return "Quit Nessie Computer — agents stop until you open it again"
        case .iconIdle: return "Nessie Computer: not working"
        case .iconWorking: return "Nessie Computer: working"
        case .iconNeedsYou: return "Nessie Computer: needs you"
        case .teamNameUnavailable: return "Team name not available yet"
        case let .programRequestTitle(agent, program):
            return "\(agent ?? "An agent") wants to run \(program)"
        case let .programRequestBody(team, command): return "\(team): \(command)"
        case .allowOnce: return "Allow once"
        case let .alwaysAllow(program): return "Always allow \(program)"
        case .dontAllow: return "Don’t allow"
        case .onlyLocalWindow: return "Only the Nessie Computer window can change this computer’s settings."
        case .invalidRequest: return "Nessie Computer couldn’t do that. Try again."
        case .teamNotFound: return "This team isn’t connected on this computer."
        case .runtimeMissing: return "Part of Nessie Computer is missing. Reinstall Nessie Computer."
        case .changeRefused: return "Nessie Computer couldn’t make this change."
        case .teamStillStopping: return "This team is still stopping. Try again in a moment."
        case .teamNotStarted: return "Nessie Computer couldn’t start this team."
        case .teamStoppedUnexpectedly: return "This team stopped unexpectedly."
        case .connectRefused: return "Nessie didn’t accept this computer. Check the team in Nessie."
        case .loginItemNeedsApproval:
            return "Allow Nessie Computer in System Settings → General → Login Items & Extensions."
        case .loginItemFailed: return "macOS couldn’t change this setting. Check Login Items in System Settings."
        case .documentsFolderMissing: return "The documents folder is missing. Choose it again."
        case .nothingDeleted: return "Nothing has been deleted yet."
        case .fileNotListed: return "That file is no longer listed."
        case .teamFolderNotReady: return "This team’s folder isn’t ready yet."
        case .fileGone: return "That file is no longer in the folder."
        case .fileBehindLink: return "That file is behind a link, so it isn’t shown."
        case .nessieNotAnswered: return "Nessie hasn’t answered this computer yet. Try again shortly."
        case .documentsStatusUnreadable: return "Couldn’t read this team’s documents status."
        case .addressNotOpened: return "Nessie sent an address that Nessie Computer doesn’t open."
        case .documentsFolderPrompt: return "Choose the folder for your Nessie documents"
        case .addressNeedsHTTPS:
            return "Enter an HTTPS address for your Nessie server, such as https://nessie.example.com."
        case .addressHasCredentials: return "Enter the server address without a username or password."
        case .addressHasPath: return "Enter only the server address, without a page path."
        case .addressMustBeHTTPS: return "The server address must start with https://."
        case .pairingFailed: return "Nessie couldn’t finish this step. Check your connection and try again."
        case .pairingCleanupRequired:
            return "Remove every local draft and stop every sandbox, then add this computer to the team again."
        case .pairingCodeMissing: return "Nessie couldn’t give a pairing code. Try again."
        case .existingTeamsUnreadable: return "Nessie Computer couldn’t check the teams already on this Mac."
        case .existingTeamNeedsAttention: return "A team on this Mac needs attention."
        case let .settingsStillOlder(attempts):
            return "Nessie still treats this Mac’s settings as older after \(count(attempts, "try", "tries")). "
                + "Disconnect this team, then add this computer to it again."
        case .settingsNotProposed: return "Nessie Computer couldn’t send these settings again."
        case .planNameRequired: return "Give this ChatGPT plan a name."
        case .planCheckFailed: return "Couldn’t check the ChatGPT plan. Try again."
        case .planCheckPending: return "The ChatGPT plan is still being checked. Try again in a moment."
        }
    }
}
