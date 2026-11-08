import Foundation

enum FrenchWords {
    /// French counts zero and one in the singular.
    private static func count(_ value: Int, _ one: String, _ many: String) -> String {
        "\(value) \(value <= 1 ? one : many)"
    }

    private static func reason(_ reason: NeedsYouReason) -> String {
        switch reason {
        case let .programs(value):
            return value == 1 ? "un programme demande à s’exécuter" : "\(value) programmes demandent à s’exécuter"
        case let .documentConflicts(value):
            return count(value, "conflit de documents", "conflits de documents")
        case .documentsNeedChecking: return "des documents sont à vérifier"
        case .allowDocumentsInNessie: return "autorisez les documents dans Nessie"
        case .allowDocumentsAgain: return "autorisez de nouveau les documents dans Nessie"
        case .documentsFolderMissing: return "le dossier des documents est introuvable"
        case .diskFull: return "le disque est plein"
        case .notConnected: return "non connectée"
        }
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    static func text(_ word: Word) -> String {
        switch word {
        case .statusNoTeam: return "Aucune équipe connectée"
        case .statusPaused: return "En pause"
        case let .statusWorking(working, paused, notConnected):
            var parts = ["Travaille pour \(count(working, "équipe", "équipes"))"]
            if paused > 0 { parts.append("\(paused) en pause") }
            if notConnected > 0 { parts.append(count(notConnected, "non connectée", "non connectées")) }
            return parts.joined(separator: " · ")
        case .statusConnecting: return "Connexion…"
        case .statusNotConnected: return "Non connecté — ouvrez Nessie Computer"
        case let .needsYou(team, why): return "Action requise : \(team) — \(reason(why))"
        case .needsYouReinstall: return "Action requise : réinstallez Nessie Computer"
        case .needsYouUnreadableTeam: return "Action requise : une équipe de ce Mac est illisible"
        case let .needsYouMany(value): return "Action requise : \(value) éléments — ouvrez Nessie Computer"
        case .pause: return "Mettre en pause"
        case .resume: return "Reprendre"
        case .allTeams: return "Toutes les équipes"
        case .openComputer: return "Ouvrir Nessie Computer…"
        case .openNessie: return "Ouvrir Nessie"
        case .quit: return "Quitter Nessie Computer"
        case .quitWhileWorking:
            return "Quitter Nessie Computer — les agents s’arrêtent jusqu’à ce que vous le rouvriez"
        case .iconIdle: return "Nessie Computer : inactif"
        case .iconWorking: return "Nessie Computer : au travail"
        case .iconNeedsYou: return "Nessie Computer : action requise"
        case .teamNameUnavailable: return "Nom de l’équipe pas encore disponible"
        case let .programRequestTitle(agent, program): return "\(agent ?? "Un agent") veut exécuter \(program)"
        case let .programRequestBody(team, command): return "\(team) : \(command)"
        case .allowOnce: return "Autoriser une fois"
        case let .alwaysAllow(program): return "Toujours autoriser \(program)"
        case .dontAllow: return "Ne pas autoriser"
        case .onlyLocalWindow:
            return "Seule la fenêtre de Nessie Computer peut modifier les réglages de cet "
                + "ordinateur."
        case .invalidRequest: return "Nessie Computer n’a pas pu le faire. Réessayez."
        case .teamNotFound: return "Cette équipe n’est pas connectée sur cet ordinateur."
        case .runtimeMissing: return "Une partie de Nessie Computer est manquante. Réinstallez Nessie Computer."
        case .changeRefused: return "Nessie Computer n’a pas pu effectuer cette modification."
        case .teamStillStopping: return "Cette équipe est encore en train de s’arrêter. Réessayez dans un instant."
        case .teamNotStarted: return "Nessie Computer n’a pas pu démarrer cette équipe."
        case .teamStoppedUnexpectedly: return "Cette équipe s’est arrêtée de façon inattendue."
        case .connectRefused: return "Nessie n’a pas accepté cet ordinateur. Vérifiez l’équipe dans Nessie."
        case .loginItemNeedsApproval:
            return "Autorisez Nessie Computer dans Réglages Système → Général → Ouverture et extensions."
        case .loginItemFailed:
            return "macOS n’a pas pu modifier ce réglage. Vérifiez les éléments d’ouverture dans Réglages Système."
        case .documentsFolderMissing: return "Le dossier des documents est introuvable. Choisissez-le de nouveau."
        case .nothingDeleted: return "Rien n’a encore été supprimé."
        case .fileNotListed: return "Ce fichier n’est plus dans la liste."
        case .teamFolderNotReady: return "Le dossier de cette équipe n’est pas encore prêt."
        case .fileGone: return "Ce fichier n’est plus dans le dossier."
        case .fileBehindLink: return "Ce fichier se trouve derrière un lien, il n’est donc pas affiché."
        case .nessieNotAnswered: return "Nessie n’a pas encore répondu à cet ordinateur. Réessayez bientôt."
        case .documentsStatusUnreadable: return "Impossible de lire l’état des documents de cette équipe."
        case .addressNotOpened: return "Nessie a envoyé une adresse que Nessie Computer n’ouvre pas."
        case .documentsFolderPrompt: return "Choisissez le dossier de vos documents Nessie"
        case .addressNeedsHTTPS:
            return "Saisissez une adresse HTTPS pour votre serveur Nessie, par exemple https://nessie.example.com."
        case .addressHasCredentials: return "Saisissez l’adresse du serveur sans nom d’utilisateur ni mot de passe."
        case .addressHasPath: return "Saisissez seulement l’adresse du serveur, sans chemin de page."
        case .addressMustBeHTTPS: return "L’adresse du serveur doit commencer par https://."
        case .pairingFailed: return "Nessie n’a pas pu terminer cette étape. Vérifiez votre connexion et réessayez."
        case .pairingCleanupRequired:
            return "Supprimez tous les brouillons locaux et arrêtez tous les bacs à sable, puis reconnectez cette "
                + "équipe."
        case .pairingCodeMissing: return "Nessie n’a pas pu fournir de code d’association. Réessayez."
        case .existingTeamsUnreadable:
            return "Nessie Computer n’a pas pu vérifier les équipes déjà présentes sur ce Mac."
        case .existingTeamNeedsAttention: return "Une équipe de ce Mac demande votre attention."
        case let .settingsStillOlder(attempts):
            return "Nessie considère toujours les réglages de ce Mac comme plus anciens après "
                + "\(count(attempts, "essai", "essais")). Déconnectez cette équipe et reconnectez-la."
        case .settingsNotProposed: return "Nessie Computer n’a pas pu renvoyer ces réglages."
        case .planNameRequired: return "Donnez un nom à cette offre ChatGPT."
        case .planCheckFailed: return "Impossible de vérifier l’offre ChatGPT. Réessayez."
        case .planCheckPending: return "L’offre ChatGPT est encore en cours de vérification. Réessayez dans un instant."
        }
    }
}
