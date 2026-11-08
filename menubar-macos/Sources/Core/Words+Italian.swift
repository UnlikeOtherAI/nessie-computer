import Foundation

enum ItalianWords {
    private static func count(_ value: Int, _ one: String, _ many: String) -> String {
        "\(value) \(value == 1 ? one : many)"
    }

    private static func reason(_ reason: NeedsYouReason) -> String {
        switch reason {
        case let .programs(value):
            return value == 1 ? "un programma chiede di avviarsi" : "\(value) programmi chiedono di avviarsi"
        case let .documentConflicts(value):
            return count(value, "conflitto nei documenti", "conflitti nei documenti")
        case .documentsNeedChecking: return "i documenti vanno controllati"
        case .allowDocumentsInNessie: return "consenti i documenti in Nessie"
        case .allowDocumentsAgain: return "consenti di nuovo i documenti in Nessie"
        case .documentsFolderMissing: return "manca la cartella dei documenti"
        case .diskFull: return "il disco è pieno"
        case .notConnected: return "non connesso"
        }
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    static func text(_ word: Word) -> String {
        switch word {
        case .statusNoTeam: return "Nessun team connesso"
        case .statusPaused: return "In pausa"
        case let .statusWorking(working, paused, notConnected):
            var parts = ["Al lavoro per \(working) team"]
            if paused > 0 { parts.append("\(paused) in pausa") }
            if notConnected > 0 { parts.append(count(notConnected, "non connesso", "non connessi")) }
            return parts.joined(separator: " · ")
        case .statusConnecting: return "Connessione…"
        case .statusNotConnected: return "Non connesso — apri Nessie Computer"
        case let .needsYou(team, why): return "Serve il tuo intervento: \(team) — \(reason(why))"
        case .needsYouReinstall: return "Serve il tuo intervento: reinstalla Nessie Computer"
        case .needsYouUnreadableTeam: return "Serve il tuo intervento: un team su questo Mac non è leggibile"
        case let .needsYouMany(value): return "Serve il tuo intervento: \(value) cose — apri Nessie Computer"
        case .pause: return "Metti in pausa"
        case .resume: return "Riprendi"
        case .allTeams: return "Tutti i team"
        case .openComputer: return "Apri Nessie Computer…"
        case .addThisComputer: return "Aggiungi questo computer…"
        case .openNessie: return "Apri Nessie"
        case .quit: return "Esci da Nessie Computer"
        case .quitWhileWorking: return "Esci da Nessie Computer — gli agenti si fermano finché non lo riapri"
        case .iconIdle: return "Nessie Computer: non al lavoro"
        case .iconWorking: return "Nessie Computer: al lavoro"
        case .iconNeedsYou: return "Nessie Computer: serve il tuo intervento"
        case .teamNameUnavailable: return "Nome del team non ancora disponibile"
        case let .programRequestTitle(agent, program): return "\(agent ?? "Un agente") vuole avviare \(program)"
        case let .programRequestBody(team, command): return "\(team): \(command)"
        case .allowOnce: return "Consenti una volta"
        case let .alwaysAllow(program): return "Consenti sempre \(program)"
        case .dontAllow: return "Non consentire"
        case .onlyLocalWindow:
            return "Solo la finestra di Nessie Computer può cambiare le impostazioni di questo "
                + "computer."
        case .invalidRequest: return "Nessie Computer non è riuscito a farlo. Riprova."
        case .teamNotFound: return "Questo team non è connesso su questo computer."
        case .runtimeMissing: return "Manca una parte di Nessie Computer. Reinstalla Nessie Computer."
        case .changeRefused: return "Nessie Computer non è riuscito ad applicare questa modifica."
        case .teamStillStopping: return "Questo team si sta ancora fermando. Riprova tra un momento."
        case .teamNotStarted: return "Nessie Computer non è riuscito ad avviare questo team."
        case .teamStoppedUnexpectedly: return "Questo team si è fermato in modo imprevisto."
        case .connectRefused: return "Nessie non ha accettato questo computer. Controlla il team in Nessie."
        case .loginItemNeedsApproval:
            return "Consenti Nessie Computer in Impostazioni di Sistema → Generali → Elementi login ed estensioni."
        case .loginItemFailed:
            return "macOS non è riuscito a cambiare questa impostazione. "
                + "Controlla gli elementi login in Impostazioni di Sistema."
        case .documentsFolderMissing: return "Manca la cartella dei documenti. Sceglila di nuovo."
        case .nothingDeleted: return "Non è stato ancora eliminato nulla."
        case .fileNotListed: return "Quel file non è più nell’elenco."
        case .teamFolderNotReady: return "La cartella di questo team non è ancora pronta."
        case .fileGone: return "Quel file non è più nella cartella."
        case .fileBehindLink: return "Quel file si trova dietro un collegamento, quindi non viene mostrato."
        case .nessieNotAnswered: return "Nessie non ha ancora risposto a questo computer. Riprova tra poco."
        case .documentsStatusUnreadable: return "Impossibile leggere lo stato dei documenti di questo team."
        case .addressNotOpened: return "Nessie ha inviato un indirizzo che Nessie Computer non apre."
        case .documentsFolderPrompt: return "Scegli la cartella per i tuoi documenti di Nessie"
        case .addressNeedsHTTPS:
            return "Inserisci un indirizzo HTTPS per il tuo server Nessie, ad esempio https://nessie.example.com."
        case .addressHasCredentials: return "Inserisci l’indirizzo del server senza nome utente né password."
        case .addressHasPath: return "Inserisci solo l’indirizzo del server, senza il percorso di una pagina."
        case .addressMustBeHTTPS: return "L’indirizzo del server deve iniziare con https://."
        case .pairingFailed:
            return "Nessie non è riuscito a completare questo passaggio. Controlla la connessione e "
                + "riprova."
        case .pairingCleanupRequired:
            return "Rimuovi tutte le bozze locali e ferma tutte le sandbox, poi aggiungi di nuovo questo computer "
                + "al team."
        case .pairingCodeMissing: return "Nessie non è riuscito a fornire un codice di abbinamento. Riprova."
        case .existingTeamsUnreadable:
            return "Nessie Computer non è riuscito a controllare i team già presenti su questo Mac."
        case .existingTeamNeedsAttention: return "Un team su questo Mac richiede attenzione."
        case let .settingsStillOlder(attempts):
            return "Nessie considera ancora più vecchie le impostazioni di questo Mac dopo "
                + "\(count(attempts, "tentativo", "tentativi")). Disconnetti questo team, "
                + "poi aggiungi di nuovo questo computer."
        case .settingsNotProposed: return "Nessie Computer non è riuscito a inviare di nuovo queste impostazioni."
        case .planNameRequired: return "Dai un nome a questo piano ChatGPT."
        case .planCheckFailed: return "Impossibile controllare il piano ChatGPT. Riprova."
        case .planCheckPending: return "Il piano ChatGPT è ancora in fase di controllo. Riprova tra un momento."
        }
    }
}
