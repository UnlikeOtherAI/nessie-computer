import Foundation

enum SpanishWords {
    private static func count(_ value: Int, _ one: String, _ many: String) -> String {
        "\(value) \(value == 1 ? one : many)"
    }

    private static func reason(_ reason: NeedsYouReason) -> String {
        switch reason {
        case let .programs(value):
            return value == 1 ? "un programa pide ejecutarse" : "\(value) programas piden ejecutarse"
        case let .documentConflicts(value):
            return count(value, "conflicto en documentos", "conflictos en documentos")
        case .documentsNeedChecking: return "hay que revisar los documentos"
        case .allowDocumentsInNessie: return "permite los documentos en Nessie"
        case .allowDocumentsAgain: return "vuelve a permitir los documentos en Nessie"
        case .documentsFolderMissing: return "falta la carpeta de documentos"
        case .diskFull: return "el disco está lleno"
        case .notConnected: return "sin conexión"
        }
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    static func text(_ word: Word) -> String {
        switch word {
        case .statusNoTeam: return "Ningún equipo conectado"
        case .statusPaused: return "En pausa"
        case let .statusWorking(working, paused, notConnected):
            var parts = ["Trabajando para \(count(working, "equipo", "equipos"))"]
            if paused > 0 { parts.append("\(paused) en pausa") }
            if notConnected > 0 { parts.append("\(notConnected) sin conexión") }
            return parts.joined(separator: " · ")
        case .statusConnecting: return "Conectando…"
        case .statusNotConnected: return "Sin conexión — abre Nessie Computer"
        case .statusUpdatesStuck: return "Las actualizaciones están atascadas — los equipos no pueden iniciarse"
        case let .needsYou(team, why): return "Te necesita: \(team) — \(reason(why))"
        case .needsYouReinstall: return "Te necesita: reinstala Nessie Computer"
        case .needsYouUnreadableTeam: return "Te necesita: no se puede leer un equipo de este Mac"
        case .needsYouUpdatesStuck: return "Te necesita: las actualizaciones están atascadas — abre Nessie Computer"
        case let .needsYouMany(value): return "Te necesita: \(value) cosas — abre Nessie Computer"
        case .pause: return "Pausar"
        case .resume: return "Reanudar"
        case .allTeams: return "Todos los equipos"
        case .openComputer: return "Abrir Nessie Computer…"
        case .addAnotherTeam: return "Añadir otro equipo…"
        case .openNessie: return "Abrir Nessie"
        case .quit: return "Salir de Nessie Computer"
        case .quitWhileWorking: return "Salir de Nessie Computer — los agentes se detienen hasta que lo vuelvas a abrir"
        case .iconIdle: return "Nessie Computer: sin trabajar"
        case .iconWorking: return "Nessie Computer: trabajando"
        case .iconNeedsYou: return "Nessie Computer: te necesita"
        case .teamNameUnavailable: return "El nombre del equipo aún no está disponible"
        case let .programRequestTitle(agent, program): return "\(agent ?? "Un agente") quiere ejecutar \(program)"
        case let .programRequestBody(team, command): return "\(team): \(command)"
        case .allowOnce: return "Permitir una vez"
        case let .alwaysAllow(program): return "Permitir siempre \(program)"
        case .dontAllow: return "No permitir"
        case .onlyLocalWindow: return "Solo la ventana de Nessie Computer puede cambiar los ajustes de este ordenador."
        case .invalidRequest: return "Nessie Computer no ha podido hacerlo. Inténtalo de nuevo."
        case .teamNotFound: return "Este equipo no está conectado en este ordenador."
        case .runtimeMissing: return "Falta una parte de Nessie Computer. Reinstala Nessie Computer."
        case .changeRefused: return "Nessie Computer no ha podido hacer este cambio."
        case .teamStillStopping: return "Este equipo aún se está deteniendo. Inténtalo dentro de un momento."
        case .teamNotStarted: return "Nessie Computer no ha podido iniciar este equipo."
        case .teamStoppedUnexpectedly: return "Este equipo se ha detenido de forma inesperada."
        case .connectRefused: return "Nessie no ha aceptado este ordenador. Revisa el equipo en Nessie."
        case .loginItemNeedsApproval:
            return "Permite Nessie Computer en Ajustes del Sistema → General → Ítems de inicio y extensiones."
        case .loginItemFailed:
            return "macOS no ha podido cambiar este ajuste. Revisa los ítems de inicio en Ajustes del Sistema."
        case .documentsFolderMissing: return "Falta la carpeta de documentos. Vuelve a elegirla."
        case .nothingDeleted: return "Todavía no se ha eliminado nada."
        case .fileNotListed: return "Ese archivo ya no aparece en la lista."
        case .teamFolderNotReady: return "La carpeta de este equipo aún no está lista."
        case .fileGone: return "Ese archivo ya no está en la carpeta."
        case .fileBehindLink: return "Ese archivo está detrás de un enlace, así que no se muestra."
        case .nessieNotAnswered: return "Nessie aún no ha respondido a este ordenador. Inténtalo dentro de poco."
        case .documentsStatusUnreadable: return "No se ha podido leer el estado de los documentos de este equipo."
        case .addressNotOpened: return "Nessie ha enviado una dirección que Nessie Computer no abre."
        case .documentsFolderPrompt: return "Elige la carpeta para tus documentos de Nessie"
        case .addressNeedsHTTPS:
            return "Escribe una dirección HTTPS para tu servidor de Nessie, como https://nessie.example.com."
        case .addressHasCredentials: return "Escribe la dirección del servidor sin usuario ni contraseña."
        case .addressHasPath: return "Escribe solo la dirección del servidor, sin la ruta de una página."
        case .addressMustBeHTTPS: return "La dirección del servidor debe empezar por https://."
        case .pairingFailed: return "Nessie no ha podido terminar este paso. Revisa tu conexión e inténtalo de nuevo."
        case .pairingCleanupRequired:
            return "Elimina todos los borradores locales y detén todos los sandboxes. Luego vuelve a añadir este "
                + "ordenador al equipo."
        case .pairingCodeMissing: return "Nessie no ha podido dar un código de vinculación. Inténtalo de nuevo."
        case .existingTeamsUnreadable:
            return "Nessie Computer no ha podido comprobar los equipos que ya hay en este Mac."
        case .existingTeamNeedsAttention: return "Un equipo de este Mac necesita atención."
        case let .settingsStillOlder(attempts):
            return "Nessie sigue considerando más antiguos los ajustes de este Mac tras "
                + "\(count(attempts, "intento", "intentos")). Desconecta este equipo "
                + "y luego vuelve a añadir este ordenador."
        case .settingsNotProposed: return "Nessie Computer no ha podido volver a enviar estos ajustes."
        case .planNameRequired: return "Ponle un nombre a este plan de ChatGPT."
        case .planCheckFailed: return "No se ha podido comprobar el plan de ChatGPT. Inténtalo de nuevo."
        case .planCheckPending: return "El plan de ChatGPT aún se está comprobando. Inténtalo dentro de un momento."
        }
    }
}
