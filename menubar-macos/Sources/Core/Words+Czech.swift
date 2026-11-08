import Foundation

enum CzechWords {
    /// Czech counts: 1 takes the singular, 2–4 the paucal, 0 and 5+ the plural genitive.
    private static func count(_ value: Int, _ one: String, _ few: String, _ many: String) -> String {
        "\(value) \(form(value, one, few, many))"
    }

    private static func form(_ value: Int, _ one: String, _ few: String, _ many: String) -> String {
        if value == 1 { return one }
        return (2...4).contains(value) ? few : many
    }

    private static func reason(_ reason: NeedsYouReason) -> String {
        switch reason {
        case let .programs(value):
            if value == 1 { return "program žádá o spuštění" }
            return "\(count(value, "program", "programy", "programů")) "
                + form(value, "žádá", "žádají", "žádá") + " o spuštění"
        case let .documentConflicts(value):
            return count(value, "konflikt", "konflikty", "konfliktů") + " v dokumentech"
        case .documentsNeedChecking: return "dokumenty je třeba zkontrolovat"
        case .allowDocumentsInNessie: return "povolte dokumenty v Nessie"
        case .allowDocumentsAgain: return "znovu povolte dokumenty v Nessie"
        case .documentsFolderMissing: return "složka s dokumenty chybí"
        case .diskFull: return "disk je plný"
        case .notConnected: return "nepřipojeno"
        }
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    static func text(_ word: Word) -> String {
        switch word {
        case .statusNoTeam: return "Žádný tým není připojený"
        case .statusPaused: return "Pozastaveno"
        case let .statusWorking(working, paused, notConnected):
            var parts = ["Pracuje pro \(count(working, "tým", "týmy", "týmů"))"]
            if paused > 0 { parts.append(count(paused, "pozastavený", "pozastavené", "pozastavených")) }
            if notConnected > 0 { parts.append(count(notConnected, "nepřipojený", "nepřipojené", "nepřipojených")) }
            return parts.joined(separator: " · ")
        case .statusConnecting: return "Připojování…"
        case .statusNotConnected: return "Nepřipojeno — otevřete Nessie Computer"
        case .statusUpdatesStuck: return "Aktualizace se zasekly — týmy nejde spustit"
        case let .needsYou(team, why): return "Potřebuje vás: \(team) — \(reason(why))"
        case .needsYouReinstall: return "Potřebuje vás: přeinstalujte Nessie Computer"
        case .needsYouUnreadableTeam: return "Potřebuje vás: tým na tomto Macu nelze načíst"
        case .needsYouConfirmComputer: return "Potřebuje vás: potvrďte tento počítač v Nessie"
        case .needsYouUpdatesStuck: return "Potřebuje vás: aktualizace se zasekly — otevřete Nessie Computer"
        case let .needsYouMany(value):
            return "Potřebuje vás: \(count(value, "věc", "věci", "věcí")) — otevřete Nessie Computer"
        case .pause: return "Pozastavit"
        case .resume: return "Pokračovat"
        case .allTeams: return "Všechny týmy"
        case .openComputer: return "Otevřít Nessie Computer…"
        case .addThisComputer: return "Přidat tento počítač…"
        case .openNessie: return "Otevřít Nessie"
        case .quit: return "Ukončit Nessie Computer"
        case .quitWhileWorking: return "Ukončit Nessie Computer — agenti se zastaví, dokud ho znovu neotevřete"
        case .iconIdle: return "Nessie Computer: nepracuje"
        case .iconWorking: return "Nessie Computer: pracuje"
        case .iconNeedsYou: return "Nessie Computer: potřebuje vás"
        case .teamNameUnavailable: return "Název týmu zatím není k dispozici"
        case let .programRequestTitle(agent, program): return "\(agent ?? "Agent") chce spustit \(program)"
        case let .programRequestBody(team, command): return "\(team): \(command)"
        case .allowOnce: return "Povolit jednou"
        case let .alwaysAllow(program): return "Vždy povolit \(program)"
        case .dontAllow: return "Nepovolit"
        case .onlyLocalWindow: return "Nastavení tohoto počítače může měnit jen okno Nessie Computer."
        case .invalidRequest: return "Nessie Computer to nedokázal provést. Zkuste to znovu."
        case .teamNotFound: return "Tento tým není na tomto počítači připojený."
        case .runtimeMissing: return "Část Nessie Computer chybí. Přeinstalujte Nessie Computer."
        case .changeRefused: return "Nessie Computer tuto změnu nedokázal provést."
        case .teamStillStopping: return "Tento tým se ještě zastavuje. Zkuste to za chvíli."
        case .teamNotStarted: return "Nessie Computer nedokázal tento tým spustit."
        case .teamStoppedUnexpectedly: return "Tento tým se nečekaně zastavil."
        case .connectRefused: return "Nessie tento počítač nepřijal. Zkontrolujte tým v Nessie."
        case .loginItemNeedsApproval:
            return "Povolte Nessie Computer v Nastavení systému → Obecné → Položky při přihlášení a rozšíření."
        case .loginItemFailed:
            return "macOS toto nastavení nedokázal změnit. Zkontrolujte Položky při přihlášení v Nastavení systému."
        case .documentsFolderMissing: return "Složka s dokumenty chybí. Vyberte ji znovu."
        case .nothingDeleted: return "Zatím nebylo nic smazáno."
        case .fileNotListed: return "Tento soubor už není v seznamu."
        case .teamFolderNotReady: return "Složka tohoto týmu ještě není připravená."
        case .fileGone: return "Tento soubor už ve složce není."
        case .fileBehindLink: return "Tento soubor je za odkazem, proto se nezobrazí."
        case .nessieNotAnswered: return "Nessie tomuto počítači zatím neodpověděl. Zkuste to za chvíli."
        case .documentsStatusUnreadable: return "Stav dokumentů tohoto týmu se nepodařilo načíst."
        case .addressNotOpened: return "Nessie poslal adresu, kterou Nessie Computer neotevře."
        case .documentsFolderPrompt: return "Vyberte složku pro své dokumenty z Nessie"
        case .addressNeedsHTTPS:
            return "Zadejte HTTPS adresu svého serveru Nessie, například https://nessie.example.com."
        case .addressHasCredentials: return "Zadejte adresu serveru bez uživatelského jména a hesla."
        case .addressHasPath: return "Zadejte jen adresu serveru, bez cesty ke stránce."
        case .addressMustBeHTTPS: return "Adresa serveru musí začínat https://."
        case .pairingFailed: return "Nessie tento krok nedokončil. Zkontrolujte připojení a zkuste to znovu."
        case .pairingCleanupRequired:
            return "Odstraňte všechny místní koncepty a zastavte všechny sandboxy, pak tento počítač do týmu "
                + "přidejte znovu."
        case .pairingCodeMissing: return "Nessie nedokázal vydat párovací kód. Zkuste to znovu."
        case .existingTeamsUnreadable:
            return "Nessie Computer nedokázal zkontrolovat týmy, které už na tomto Macu "
                + "jsou."
        case .existingTeamNeedsAttention: return "Tým na tomto Macu vyžaduje pozornost."
        case let .settingsStillOlder(attempts):
            return "Nessie považuje nastavení tohoto Macu za starší i po \(attempts) "
                + (attempts == 1 ? "pokusu" : "pokusech") + ". Odpojte tento tým a pak do něj "
                + "tento počítač přidejte znovu."
        case .settingsNotProposed: return "Nessie Computer nedokázal tato nastavení znovu odeslat."
        case .planNameRequired: return "Pojmenujte tento plán ChatGPT."
        case .planCheckFailed: return "Plán ChatGPT se nepodařilo zkontrolovat. Zkuste to znovu."
        case .planCheckPending: return "Plán ChatGPT se ještě kontroluje. Zkuste to za chvíli."
        }
    }
}
