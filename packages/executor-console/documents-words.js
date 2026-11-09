// The Documents tab's words in every console locale, registered with the shell
// as `documents.*`. A counted sentence is an Intl plural set; {n}, {team},
// {path} and {date} are filled in by the helpers at the end. Reason codes live
// in documents-reasons-words.js.
const documentsEnglish = {
  switchLabel: 'Keep a copy of {team}’s documents on this computer',
  intro: 'All of {team}’s documents, in one folder on this computer. Edits there go back to Nessie.', folder: 'Folder',
  suggested: '{path} (suggested)', choose: 'Choose folder…', pause: 'Pause', resume: 'Resume', openFolder: 'Open folder',
  deletedFiles: 'Deleted files…', openNessie: 'Allow in Nessie', checking: 'Checking…',
  state: {
    off: 'Off', starting: 'Starting…', waiting_for_confirmation: 'Waiting for you to allow it in Nessie', up_to_date: 'Up to date', paused: 'Paused',
    root_missing: 'Folder missing — choose it again', disk_full: 'Disk full', needs_attention: 'Needs your attention',
    needs_reauthorization: 'Waiting for you to allow it again in Nessie', offline: 'Offline', not_private: 'Not available on a shared computer',
  },
  syncing: { one: 'Syncing {n} file', other: 'Syncing {n} files' }, syncingNone: 'Syncing…',
  conflicts: 'Files to check', keepMine: 'Use my version', keepNessie: 'Use Nessie’s version', keepBoth: 'Keep both', show: 'Show in folder', ok: 'Dismiss',
  existing: {
    title: 'Add these files to Nessie?',
    body: {
      one: 'This folder already has {n} file. It will be added to Nessie for {team}.',
      other: 'This folder already has {n} files. They will be added to Nessie for {team}.',
    },
    accept: 'Add and sync', cancel: 'Cancel',
  },
  deleted: {
    title: 'Deleted files', hint: 'Files that sync removed from this folder stay here for 30 days.',
    empty: 'Nothing has been deleted in the last 30 days.', restore: 'Restore', on: 'Deleted {date}', close: 'Close', open: 'Open folder',
  },
  statusFailed: 'Couldn’t check sync on this computer.', retry: 'Try again',
  saved: {
    on: 'Sync is on for {team}', off: 'Sync is off for {team}', folder: 'Sync folder changed for {team}', paused: 'Sync paused for {team}',
    resumed: 'Sync resumed for {team}',
  },
  restored: 'Restored {path}',
  destination: { on: '{team}’s documents go in {path}', off: '{team}’s documents will go in {path}' },
}

const documentsByLocale = {
  'en-GB': documentsEnglish,
  'en-US': documentsEnglish,
  cs: {
    switchLabel: 'Uchovávat kopii dokumentů týmu {team} na tomto počítači',
    intro: 'Všechny dokumenty týmu {team} v jedné složce na tomto počítači. Úpravy v ní se vrací do Nessie.', folder: 'Složka',
    suggested: '{path} (doporučeno)', choose: 'Vybrat složku…', pause: 'Pozastavit', resume: 'Pokračovat', openFolder: 'Otevřít složku',
    deletedFiles: 'Smazané soubory…', openNessie: 'Povolit v Nessie', checking: 'Kontrola…',
    state: {
      off: 'Vypnuto', starting: 'Spouštění…', waiting_for_confirmation: 'Čeká, až to povolíte v Nessie', up_to_date: 'Aktuální',
      paused: 'Pozastaveno', root_missing: 'Složka chybí — vyberte ji znovu', disk_full: 'Disk je plný', needs_attention: 'Vyžaduje vaši pozornost',
      needs_reauthorization: 'Čeká, až to znovu povolíte v Nessie', offline: 'Offline', not_private: 'Na sdíleném počítači není k dispozici',
    },
    syncing: {
      one: 'Synchronizuje se {n} soubor', few: 'Synchronizují se {n} soubory', many: 'Synchronizuje se {n} souboru',
      other: 'Synchronizuje se {n} souborů',
    },
    syncingNone: 'Synchronizuje se…',
    conflicts: 'Soubory ke kontrole', keepMine: 'Použít moji verzi', keepNessie: 'Použít verzi z Nessie', keepBoth: 'Ponechat obě', show: 'Zobrazit ve složce',
    ok: 'Skrýt',
    existing: {
      title: 'Přidat tyto soubory do Nessie?',
      body: {
        one: 'Tato složka už obsahuje {n} soubor. Přidá se do Nessie pro tým {team}.',
        few: 'Tato složka už obsahuje {n} soubory. Přidají se do Nessie pro tým {team}.',
        many: 'Tato složka už obsahuje {n} souboru. Přidají se do Nessie pro tým {team}.',
        other: 'Tato složka už obsahuje {n} souborů. Přidají se do Nessie pro tým {team}.',
      },
      accept: 'Přidat a synchronizovat', cancel: 'Zrušit',
    },
    deleted: {
      title: 'Smazané soubory', hint: 'Soubory, které synchronizace z této složky odstranila, tu zůstanou 30 dní.',
      empty: 'Za posledních 30 dní se nic nesmazalo.', restore: 'Obnovit', on: 'Smazáno {date}', close: 'Zavřít', open: 'Otevřít složku',
    },
    statusFailed: 'Synchronizaci na tomto počítači se nepodařilo ověřit.', retry: 'Zkusit znovu',
    saved: {
      on: 'Synchronizace pro {team} je zapnutá', off: 'Synchronizace pro {team} je vypnutá', folder: 'Složka synchronizace pro {team} je změněná',
      paused: 'Synchronizace pro {team} je pozastavená', resumed: 'Synchronizace pro {team} pokračuje',
    },
    restored: 'Obnoveno: {path}',
    destination: { on: 'Dokumenty týmu {team} se ukládají do {path}', off: 'Dokumenty týmu {team} se budou ukládat do {path}' },
  },
  de: {
    switchLabel: 'Eine Kopie der Dokumente von {team} auf diesem Computer behalten',
    intro: 'Alle Dokumente von {team} in einem Ordner auf diesem Computer. Änderungen dort gehen zurück an Nessie.',
    folder: 'Ordner', suggested: '{path} (Vorschlag)', choose: 'Ordner wählen…', pause: 'Pausieren', resume: 'Fortsetzen',
    openFolder: 'Ordner öffnen', deletedFiles: 'Gelöschte Dateien…', openNessie: 'In Nessie erlauben', checking: 'Wird geprüft…',
    state: {
      off: 'Aus', starting: 'Wird gestartet…', waiting_for_confirmation: 'Wartet auf Ihre Freigabe in Nessie', up_to_date: 'Auf dem neuesten Stand',
      paused: 'Pausiert', root_missing: 'Ordner fehlt – bitte neu wählen', disk_full: 'Datenträger voll',
      needs_attention: 'Braucht Ihre Aufmerksamkeit', needs_reauthorization: 'Wartet auf Ihre erneute Freigabe in Nessie', offline: 'Offline',
      not_private: 'Auf einem gemeinsam genutzten Computer nicht verfügbar',
    },
    syncing: { one: '{n} Datei wird synchronisiert', other: '{n} Dateien werden synchronisiert' }, syncingNone: 'Wird synchronisiert…',
    conflicts: 'Zu prüfende Dateien', keepMine: 'Meine Version verwenden', keepNessie: 'Nessie-Version verwenden', keepBoth: 'Beide behalten', show: 'Im Ordner zeigen',
    ok: 'Ausblenden',
    existing: {
      title: 'Diese Dateien zu Nessie hinzufügen?',
      body: {
        one: 'Dieser Ordner enthält bereits {n} Datei. Sie wird für {team} zu Nessie hinzugefügt.',
        other: 'Dieser Ordner enthält bereits {n} Dateien. Sie werden für {team} zu Nessie hinzugefügt.',
      },
      accept: 'Hinzufügen und synchronisieren', cancel: 'Abbrechen',
    },
    deleted: {
      title: 'Gelöschte Dateien', hint: 'Dateien, die die Synchronisierung aus diesem Ordner entfernt hat, bleiben 30 Tage hier.',
      empty: 'In den letzten 30 Tagen wurde nichts gelöscht.', restore: 'Wiederherstellen', on: 'Gelöscht am {date}', close: 'Schließen',
      open: 'Ordner öffnen',
    },
    statusFailed: 'Die Synchronisierung auf diesem Computer konnte nicht geprüft werden.', retry: 'Erneut versuchen',
    saved: {
      on: 'Synchronisierung für {team} ist an', off: 'Synchronisierung für {team} ist aus', folder: 'Synchronisierungsordner für {team} geändert',
      paused: 'Synchronisierung für {team} pausiert', resumed: 'Synchronisierung für {team} fortgesetzt',
    },
    restored: 'Wiederhergestellt: {path}',
    destination: {
      on: 'Die Dokumente von {team} werden in {path} gespeichert', off: 'Die Dokumente von {team} werden künftig in {path} gespeichert',
    },
  },
  es: {
    switchLabel: 'Guardar una copia de los documentos de {team} en este ordenador',
    intro: 'Todos los documentos de {team}, en una carpeta de este ordenador. Lo que edites ahí vuelve a Nessie.',
    folder: 'Carpeta', suggested: '{path} (sugerida)', choose: 'Elegir carpeta…', pause: 'Pausar', resume: 'Reanudar', openFolder: 'Abrir carpeta',
    deletedFiles: 'Archivos eliminados…', openNessie: 'Permitir en Nessie', checking: 'Comprobando…',
    state: {
      off: 'Desactivada', starting: 'Iniciando…', waiting_for_confirmation: 'Esperando a que lo permitas en Nessie', up_to_date: 'Al día',
      paused: 'En pausa', root_missing: 'Falta la carpeta: elígela de nuevo', disk_full: 'Disco lleno', needs_attention: 'Necesita tu atención',
      needs_reauthorization: 'Esperando a que vuelvas a permitirlo en Nessie', offline: 'Sin conexión',
      not_private: 'No disponible en un ordenador compartido',
    },
    syncing: { one: 'Sincronizando {n} archivo', other: 'Sincronizando {n} archivos' }, syncingNone: 'Sincronizando…',
    conflicts: 'Archivos para revisar', keepMine: 'Usar mi versión', keepNessie: 'Usar la versión de Nessie', keepBoth: 'Conservar ambas',
    show: 'Mostrar en la carpeta', ok: 'Descartar',
    existing: {
      title: '¿Añadir estos archivos a Nessie?',
      body: {
        one: 'Esta carpeta ya tiene {n} archivo. Se añadirá a Nessie para {team}.',
        other: 'Esta carpeta ya tiene {n} archivos. Se añadirán a Nessie para {team}.',
      },
      accept: 'Añadir y sincronizar', cancel: 'Cancelar',
    },
    deleted: {
      title: 'Archivos eliminados', hint: 'Los archivos que la sincronización quitó de esta carpeta se guardan aquí 30 días.',
      empty: 'No se eliminó nada en los últimos 30 días.', restore: 'Restaurar', on: 'Eliminado el {date}', close: 'Cerrar', open: 'Abrir carpeta',
    },
    statusFailed: 'No se pudo comprobar la sincronización en este ordenador.', retry: 'Reintentar',
    saved: {
      on: 'Sincronización activada para {team}', off: 'Sincronización desactivada para {team}',
      folder: 'Carpeta de sincronización cambiada para {team}', paused: 'Sincronización en pausa para {team}',
      resumed: 'Sincronización reanudada para {team}',
    },
    restored: 'Restaurado: {path}',
    destination: { on: 'Los documentos de {team} se guardan en {path}', off: 'Los documentos de {team} se guardarán en {path}' },
  },
  fr: {
    switchLabel: 'Garder une copie des documents de {team} sur cet ordinateur',
    intro: 'Tous les documents de {team}, dans un dossier sur cet ordinateur. Vos modifications y repartent vers Nessie.',
    folder: 'Dossier', suggested: '{path} (suggéré)', choose: 'Choisir un dossier…', pause: 'Mettre en pause', resume: 'Reprendre',
    openFolder: 'Ouvrir le dossier', deletedFiles: 'Fichiers supprimés…', openNessie: 'Autoriser dans Nessie', checking: 'Vérification…',
    state: {
      off: 'Désactivée', starting: 'Démarrage…', waiting_for_confirmation: 'En attente de votre autorisation dans Nessie', up_to_date: 'À jour',
      paused: 'En pause', root_missing: 'Dossier introuvable — choisissez-le à nouveau', disk_full: 'Disque plein',
      needs_attention: 'Requiert votre attention', needs_reauthorization: 'En attente d’une nouvelle autorisation dans Nessie',
      offline: 'Hors ligne', not_private: 'Indisponible sur un ordinateur partagé',
    },
    syncing: { one: 'Synchronisation de {n} fichier', other: 'Synchronisation de {n} fichiers' }, syncingNone: 'Synchronisation…',
    conflicts: 'Fichiers à vérifier', keepMine: 'Utiliser ma version', keepNessie: 'Utiliser la version de Nessie', keepBoth: 'Garder les deux',
    show: 'Afficher dans le dossier', ok: 'Ignorer',
    existing: {
      title: 'Ajouter ces fichiers à Nessie ?',
      body: {
        one: 'Ce dossier contient déjà {n} fichier. Il sera ajouté à Nessie pour {team}.',
        other: 'Ce dossier contient déjà {n} fichiers. Ils seront ajoutés à Nessie pour {team}.',
      },
      accept: 'Ajouter et synchroniser', cancel: 'Annuler',
    },
    deleted: {
      title: 'Fichiers supprimés', hint: 'Les fichiers que la synchronisation a retirés de ce dossier restent ici 30 jours.',
      empty: 'Rien n’a été supprimé ces 30 derniers jours.', restore: 'Restaurer', on: 'Supprimé le {date}', close: 'Fermer',
      open: 'Ouvrir le dossier',
    },
    statusFailed: 'Impossible de vérifier la synchronisation sur cet ordinateur.', retry: 'Réessayer',
    saved: {
      on: 'Synchronisation activée pour {team}', off: 'Synchronisation désactivée pour {team}',
      folder: 'Dossier de synchronisation modifié pour {team}', paused: 'Synchronisation en pause pour {team}',
      resumed: 'Synchronisation reprise pour {team}',
    },
    restored: 'Restauré : {path}',
    destination: { on: 'Les documents de {team} sont enregistrés dans {path}', off: 'Les documents de {team} seront enregistrés dans {path}' },
  },
  it: {
    switchLabel: 'Conserva una copia dei documenti di {team} su questo computer',
    intro: 'Tutti i documenti di {team}, in una cartella su questo computer. Le modifiche fatte lì tornano in Nessie.',
    folder: 'Cartella', suggested: '{path} (consigliata)', choose: 'Scegli cartella…', pause: 'Metti in pausa', resume: 'Riprendi',
    openFolder: 'Apri cartella', deletedFiles: 'File eliminati…', openNessie: 'Consenti in Nessie', checking: 'Verifica…',
    state: {
      off: 'Disattivata', starting: 'Avvio…', waiting_for_confirmation: 'In attesa della tua autorizzazione in Nessie', up_to_date: 'Aggiornata',
      paused: 'In pausa', root_missing: 'Cartella mancante: sceglila di nuovo', disk_full: 'Disco pieno',
      needs_attention: 'Richiede la tua attenzione', needs_reauthorization: 'In attesa di una nuova autorizzazione in Nessie', offline: 'Offline',
      not_private: 'Non disponibile su un computer condiviso',
    },
    syncing: { one: 'Sincronizzazione di {n} file', other: 'Sincronizzazione di {n} file' }, syncingNone: 'Sincronizzazione…',
    conflicts: 'File da controllare', keepMine: 'Usa la mia versione', keepNessie: 'Usa la versione di Nessie', keepBoth: 'Tieni entrambe',
    show: 'Mostra nella cartella', ok: 'Ignora',
    existing: {
      title: 'Aggiungere questi file a Nessie?',
      body: {
        one: 'Questa cartella contiene già {n} file. Verrà aggiunto a Nessie per {team}.',
        other: 'Questa cartella contiene già {n} file. Verranno aggiunti a Nessie per {team}.',
      },
      accept: 'Aggiungi e sincronizza', cancel: 'Annulla',
    },
    deleted: {
      title: 'File eliminati', hint: 'I file che la sincronizzazione ha tolto da questa cartella restano qui per 30 giorni.',
      empty: 'Negli ultimi 30 giorni non è stato eliminato nulla.', restore: 'Ripristina', on: 'Eliminato il {date}', close: 'Chiudi',
      open: 'Apri cartella',
    },
    statusFailed: 'Impossibile verificare la sincronizzazione su questo computer.', retry: 'Riprova',
    saved: {
      on: 'Sincronizzazione attiva per {team}', off: 'Sincronizzazione disattivata per {team}',
      folder: 'Cartella di sincronizzazione cambiata per {team}', paused: 'Sincronizzazione in pausa per {team}',
      resumed: 'Sincronizzazione ripresa per {team}',
    },
    restored: 'Ripristinato: {path}',
    destination: { on: 'I documenti di {team} vengono salvati in {path}', off: 'I documenti di {team} verranno salvati in {path}' },
  },
}

// The shell resolves the locale once and writes it on <html lang>; the plural
// and date helpers here follow that same choice.
window.documentsWords = (() => {
  const nc = window.nc
  const table = Object.fromEntries(Object.keys(documentsByLocale).map((locale) => [locale,
    { ...documentsByLocale[locale], ...window.documentsReasonsByLocale[locale] }]))
  nc.words.register('documents', table)
  const locale = () => (document.documentElement.lang in table ? document.documentElement.lang : 'en-GB')
  const fill = (text, values = {}) => text.replace(/\{(\w+)\}/g,
    (whole, name) => (name in values ? String(values[name]) : whole))
  const pick = (path) => path.split('.').reduce((node, key) => node?.[key], table[locale()])
  return {
    /** A sentence by its dotted key, with its placeholders filled. */
    text: (path, values) => nc.t(`documents.${path}`, values),
    /** A sentence that may be missing for a code: the sentence, or undefined. */
    maybe: (path) => pick(path),
    /** A counted sentence: the locale's plural form for `n`, or `other`. */
    count: (path, n, values = {}) => {
      const forms = pick(path)
      return fill(forms[new Intl.PluralRules(locale()).select(n)] ?? forms.other,
        { ...values, n: new Intl.NumberFormat(locale()).format(n) })
    },
    date: (iso) => new Intl.DateTimeFormat(locale(), { dateStyle: 'medium' }).format(new Date(iso)),
  }
})()
