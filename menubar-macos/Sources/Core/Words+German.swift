import Foundation

enum GermanWords {
    private static func count(_ value: Int, _ one: String, _ many: String) -> String {
        "\(value) \(value == 1 ? one : many)"
    }

    private static func reason(_ reason: NeedsYouReason) -> String {
        switch reason {
        case let .programs(value):
            return value == 1 ? "ein Programm möchte starten" : "\(value) Programme möchten starten"
        case let .documentConflicts(value):
            return count(value, "Konflikt in Dokumenten", "Konflikte in Dokumenten")
        case .documentsNeedChecking: return "Dokumente müssen geprüft werden"
        case .allowDocumentsInNessie: return "Dokumente in Nessie erlauben"
        case .allowDocumentsAgain: return "Dokumente in Nessie erneut erlauben"
        case .documentsFolderMissing: return "der Dokumentordner fehlt"
        case .diskFull: return "der Speicher ist voll"
        case .notConnected: return "nicht verbunden"
        }
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    static func text(_ word: Word) -> String {
        switch word {
        case .statusNoTeam: return "Kein Team verbunden"
        case .statusPaused: return "Pausiert"
        case let .statusWorking(working, paused, notConnected):
            var parts = ["Arbeitet für \(count(working, "Team", "Teams"))"]
            if paused > 0 { parts.append("\(paused) pausiert") }
            if notConnected > 0 { parts.append("\(notConnected) nicht verbunden") }
            return parts.joined(separator: " · ")
        case .statusConnecting: return "Verbinden …"
        case .statusNotConnected: return "Nicht verbunden – Nessie Computer öffnen"
        case .statusUpdatesStuck: return "Updates hängen – Teams können nicht starten"
        case let .needsYou(team, why): return "Braucht Sie: \(team) – \(reason(why))"
        case .needsYouReinstall: return "Braucht Sie: Nessie Computer neu installieren"
        case .needsYouUnreadableTeam: return "Braucht Sie: Ein Team auf diesem Mac kann nicht gelesen werden"
        case .needsYouConfirmComputer: return "Braucht Sie: Bestätigen Sie diesen Computer in Nessie"
        case .needsYouUpdatesStuck: return "Braucht Sie: Updates hängen – Nessie Computer öffnen"
        case let .needsYouMany(value): return "Braucht Sie: \(value) Dinge – Nessie Computer öffnen"
        case .pause: return "Pausieren"
        case .resume: return "Fortsetzen"
        case .allTeams: return "Alle Teams"
        case .openComputer: return "Nessie Computer öffnen …"
        case .addAnotherTeam: return "Weiteres Team hinzufügen …"
        case .openNessie: return "Nessie öffnen"
        case .quit: return "Nessie Computer beenden"
        case .quitWhileWorking: return "Nessie Computer beenden – Agenten stoppen, bis Sie es wieder öffnen"
        case .iconIdle: return "Nessie Computer: arbeitet nicht"
        case .iconWorking: return "Nessie Computer: arbeitet"
        case .iconNeedsYou: return "Nessie Computer: braucht Sie"
        case .teamNameUnavailable: return "Teamname noch nicht verfügbar"
        case let .programRequestTitle(agent, program):
            return "\(agent ?? "Ein Agent") möchte \(program) ausführen"
        case let .programRequestBody(team, command): return "\(team): \(command)"
        case .allowOnce: return "Einmal erlauben"
        case let .alwaysAllow(program): return "\(program) immer erlauben"
        case .dontAllow: return "Nicht erlauben"
        case .onlyLocalWindow:
            return "Nur das Fenster von Nessie Computer kann die Einstellungen dieses Computers ändern."
        case .invalidRequest: return "Nessie Computer konnte das nicht ausführen. Versuchen Sie es erneut."
        case .teamNotFound: return "Dieses Team ist auf diesem Computer nicht verbunden."
        case .runtimeMissing: return "Ein Teil von Nessie Computer fehlt. Installieren Sie Nessie Computer neu."
        case .changeRefused: return "Nessie Computer konnte diese Änderung nicht vornehmen."
        case .teamStillStopping: return "Dieses Team wird noch gestoppt. Versuchen Sie es gleich erneut."
        case .teamNotStarted: return "Nessie Computer konnte dieses Team nicht starten."
        case .teamStoppedUnexpectedly: return "Dieses Team wurde unerwartet gestoppt."
        case .connectRefused: return "Nessie hat diesen Computer nicht angenommen. Prüfen Sie das Team in Nessie."
        case .loginItemNeedsApproval:
            return "Erlauben Sie Nessie Computer in den Systemeinstellungen → Allgemein → Anmeldeobjekte & "
                + "Erweiterungen."
        case .loginItemFailed:
            return "macOS konnte diese Einstellung nicht ändern. Prüfen Sie die Anmeldeobjekte in den "
                + "Systemeinstellungen."
        case .documentsFolderMissing: return "Der Dokumentordner fehlt. Wählen Sie ihn erneut aus."
        case .nothingDeleted: return "Es wurde noch nichts gelöscht."
        case .fileNotListed: return "Diese Datei ist nicht mehr aufgeführt."
        case .teamFolderNotReady: return "Der Ordner dieses Teams ist noch nicht bereit."
        case .fileGone: return "Diese Datei ist nicht mehr im Ordner."
        case .fileBehindLink: return "Diese Datei liegt hinter einem Link und wird deshalb nicht angezeigt."
        case .nessieNotAnswered:
            return "Nessie hat diesem Computer noch nicht geantwortet. Versuchen Sie es gleich "
                + "erneut."
        case .documentsStatusUnreadable: return "Der Dokumentstatus dieses Teams konnte nicht gelesen werden."
        case .addressNotOpened: return "Nessie hat eine Adresse gesendet, die Nessie Computer nicht öffnet."
        case .documentsFolderPrompt: return "Wählen Sie den Ordner für Ihre Nessie-Dokumente"
        case .addressNeedsHTTPS:
            return "Geben Sie eine HTTPS-Adresse für Ihren Nessie-Server ein, zum Beispiel https://nessie.example.com."
        case .addressHasCredentials: return "Geben Sie die Serveradresse ohne Benutzernamen oder Passwort ein."
        case .addressHasPath: return "Geben Sie nur die Serveradresse ein, ohne Seitenpfad."
        case .addressMustBeHTTPS: return "Die Serveradresse muss mit https:// beginnen."
        case .pairingFailed:
            return "Nessie konnte diesen Schritt nicht abschließen. Prüfen Sie Ihre Verbindung und versuchen Sie es "
                + "erneut."
        case .pairingCleanupRequired:
            return "Entfernen Sie alle lokalen Entwürfe und stoppen Sie alle Sandboxes. Fügen Sie diesen Computer "
                + "dann erneut dem Team hinzu."
        case .pairingCodeMissing: return "Nessie konnte keinen Kopplungscode ausgeben. Versuchen Sie es erneut."
        case .existingTeamsUnreadable:
            return "Nessie Computer konnte die Teams, die schon auf diesem Mac sind, nicht prüfen."
        case .existingTeamNeedsAttention: return "Ein Team auf diesem Mac braucht Aufmerksamkeit."
        case let .settingsStillOlder(attempts):
            return "Nessie hält die Einstellungen dieses Macs auch nach \(count(attempts, "Versuch", "Versuchen")) "
                + "für älter. Trennen Sie dieses Team und fügen Sie diesen Computer dann erneut hinzu."
        case .settingsNotProposed: return "Nessie Computer konnte diese Einstellungen nicht erneut senden."
        case .planNameRequired: return "Geben Sie diesem ChatGPT-Plan einen Namen."
        case .planCheckFailed: return "Der ChatGPT-Plan konnte nicht geprüft werden. Versuchen Sie es erneut."
        case .planCheckPending: return "Der ChatGPT-Plan wird noch geprüft. Versuchen Sie es gleich erneut."
        }
    }
}
