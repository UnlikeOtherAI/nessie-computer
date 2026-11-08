type UpdateWords = { channel: string; unsupported: string; on: string; off: string; available: string; waiting: string;
  failed: string; prompt: string; requested: string; requestFailed: string; unavailable: string }

const translations: Record<string, UpdateWords> = {
  "en": {
    "channel": "Release channel: {channel}.",
    "unsupported": "Update this installation with its package manager.",
    "on": "Automatic updates: on.",
    "off": "Automatic updates: off.",
    "available": "Version {version} is available.",
    "waiting": "The update will wait for active work to finish.",
    "failed": "The update failed. Run nessie-executor updates install to retry.",
    "prompt": "Nessie Computer {version} is available. Run nessie-executor updates install to update, or nessie-executor updates remind to ask again in 24 hours.",
    "requested": "Update requested. Active work will finish before installation.",
    "requestFailed": "Couldn't request the update. Please try again.",
    "unavailable": "The installed Nessie Computer updater could not be reached."
  },
  "cs": {
    "channel": "Kanál vydání: {channel}.",
    "unsupported": "Tuto instalaci aktualizujte pomocí správce balíčků.",
    "on": "Automatické aktualizace: zapnuté.",
    "off": "Automatické aktualizace: vypnuté.",
    "available": "Je dostupná verze {version}.",
    "waiting": "Aktualizace počká na dokončení probíhající práce.",
    "failed": "Aktualizace se nezdařila. Zkuste ji znovu příkazem nessie-executor updates install.",
    "prompt": "Je dostupná verze Nessie Computer {version}. Aktualizujte příkazem nessie-executor updates install, nebo připomeňte za 24 hodin příkazem nessie-executor updates remind.",
    "requested": "Aktualizace byla vyžádána. Instalace počká na dokončení probíhající práce.",
    "requestFailed": "Aktualizaci se nepodařilo vyžádat. Zkuste to znovu.",
    "unavailable": "Nainstalovaný aktualizátor Nessie Computer není dostupný."
  },
  "de": {
    "channel": "Veröffentlichungskanal: {channel}.",
    "unsupported": "Aktualisieren Sie diese Installation mit der Paketverwaltung.",
    "on": "Automatische Updates: aktiviert.",
    "off": "Automatische Updates: deaktiviert.",
    "available": "Version {version} ist verfügbar.",
    "waiting": "Das Update wartet, bis die laufende Arbeit beendet ist.",
    "failed": "Das Update ist fehlgeschlagen. Erneut versuchen mit nessie-executor updates install.",
    "prompt": "Nessie Computer {version} ist verfügbar. Aktualisieren mit nessie-executor updates install oder in 24 Stunden erinnern mit nessie-executor updates remind.",
    "requested": "Update angefordert. Die laufende Arbeit wird vor der Installation beendet.",
    "requestFailed": "Das Update konnte nicht angefordert werden. Bitte erneut versuchen.",
    "unavailable": "Der installierte Nessie Computer-Updater ist nicht erreichbar."
  },
  "fr": {
    "channel": "Canal de publication : {channel}.",
    "unsupported": "Mettez cette installation à jour avec son gestionnaire de paquets.",
    "on": "Mises à jour automatiques : activées.",
    "off": "Mises à jour automatiques : désactivées.",
    "available": "La version {version} est disponible.",
    "waiting": "La mise à jour attendra la fin du travail en cours.",
    "failed": "La mise à jour a échoué. Réessayez avec nessie-executor updates install.",
    "prompt": "Nessie Computer {version} est disponible. Lancez nessie-executor updates install pour mettre à jour, ou nessie-executor updates remind pour un rappel dans 24 heures.",
    "requested": "Mise à jour demandée. Le travail en cours se terminera avant l'installation.",
    "requestFailed": "Impossible de demander la mise à jour. Veuillez réessayer.",
    "unavailable": "Le programme de mise à jour de Nessie Computer installé est inaccessible."
  },
  "it": {
    "channel": "Canale di rilascio: {channel}.",
    "unsupported": "Aggiorna questa installazione con il suo gestore di pacchetti.",
    "on": "Aggiornamenti automatici: attivati.",
    "off": "Aggiornamenti automatici: disattivati.",
    "available": "È disponibile la versione {version}.",
    "waiting": "L'aggiornamento attenderà la fine del lavoro in corso.",
    "failed": "Aggiornamento non riuscito. Riprova con nessie-executor updates install.",
    "prompt": "È disponibile Nessie Computer {version}. Esegui nessie-executor updates install per aggiornare, oppure nessie-executor updates remind per un promemoria tra 24 ore.",
    "requested": "Aggiornamento richiesto. Il lavoro in corso terminerà prima dell'installazione.",
    "requestFailed": "Impossibile richiedere l'aggiornamento. Riprova.",
    "unavailable": "Il programma di aggiornamento di Nessie Computer installato non è raggiungibile."
  },
  "es": {
    "channel": "Canal de publicación: {channel}.",
    "unsupported": "Actualiza esta instalación con su gestor de paquetes.",
    "on": "Actualizaciones automáticas: activadas.",
    "off": "Actualizaciones automáticas: desactivadas.",
    "available": "La versión {version} está disponible.",
    "waiting": "La actualización esperará a que termine el trabajo en curso.",
    "failed": "La actualización ha fallado. Inténtalo de nuevo con nessie-executor updates install.",
    "prompt": "Nessie Computer {version} está disponible. Ejecuta nessie-executor updates install para actualizar, o nessie-executor updates remind para recordarlo en 24 horas.",
    "requested": "Actualización solicitada. El trabajo en curso terminará antes de la instalación.",
    "requestFailed": "No se pudo solicitar la actualización. Inténtalo de nuevo.",
    "unavailable": "No se puede acceder al actualizador instalado de Nessie Computer."
  },
}

/** The operating system supplies a structured locale, never inferred message content. */
export const cliUpdateWords = (): UpdateWords => {
  const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG
    || Intl.DateTimeFormat().resolvedOptions().locale
  return translations[locale.split(/[_.-]/u)[0]!.toLowerCase()] ?? translations.en!
}

