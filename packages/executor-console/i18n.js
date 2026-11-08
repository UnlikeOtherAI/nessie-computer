// One translation module for the whole console. Every script registers its
// own namespace with all seven locales; `nc.t` resolves one locale, chosen
// once from the OS language, and `<html lang>` follows it.
(() => {
  const LOCALES = ['en-GB', 'en-US', 'cs', 'de', 'es', 'fr', 'it']
  const resolveLocale = (languages) => {
    for (const language of languages) {
      const tag = String(language || '').toLowerCase()
      if (tag === 'en-us') return 'en-US'
      if (tag === 'en' || tag.startsWith('en-')) return 'en-GB'
      const base = tag.split('-')[0]
      const match = LOCALES.find((locale) => locale.toLowerCase() === base)
      if (match) return match
    }
    return 'en-GB'
  }
  const locale = resolveLocale([...(navigator.languages ?? []), navigator.language])
  document.documentElement.lang = locale
  const plurals = new Intl.PluralRules(locale)
  const dictionaries = new Map()
  const missing = new Set()

  /** Registers one namespace; every locale must be present so a missing translation fails loudly at load. */
  const register = (namespace, words) => {
    for (const code of LOCALES) {
      if (!words[code] || typeof words[code] !== 'object') throw new Error(`Translations for ${namespace} lack ${code}.`)
    }
    dictionaries.set(namespace, words)
  }

  const lookup = (key) => {
    const [namespace, ...rest] = key.split('.')
    let node = dictionaries.get(namespace)?.[locale]
    for (const part of rest) node = node?.[part]
    return node
  }

  const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match))

  /**
   * `t('overview.teams')`; `t('overview.folders', { count: 2 })` picks the
   * plural form (`one`, `few`, `many`, `other`) and fills `{count}`.
   */
  const t = (key, vars = {}) => {
    const entry = lookup(key)
    if (entry === undefined) {
      if (!missing.has(key)) { missing.add(key); console.warn(`Missing translation: ${key}`) }
      return key
    }
    if (typeof entry === 'string') return fill(entry, vars)
    const form = typeof vars.count === 'number' ? plurals.select(vars.count) : 'other'
    return fill(entry[form] ?? entry.other ?? '', vars)
  }

  window.nc = Object.assign(window.nc ?? {}, { locale, t, words: { register, locales: LOCALES } })

  // The shell's own words: window title, tabs, header controls, team row and footer.
  register('shell', {
    'en-GB': {
      title: 'Nessie Computer', tabs: 'Nessie Computer', overview: 'Overview', access: 'Access', documents: 'Documents',
      ai: 'AI', settings: 'Settings', team: 'Team', pauseAll: 'Pause all', resumeAll: 'Resume all',
      openNessie: 'Open Nessie', tryAgain: 'Try again', cancel: 'Cancel', close: 'Close', done: 'Done', details: 'Details',
      noTeam: 'Add this computer to a team to choose what that team may use.', addComputer: 'Add this computer',
      loadingTeam: 'Loading settings for {team}…', loadFailed: 'Couldn’t load settings for {team}.',
      teamNameUnknown: 'Team name not available yet',
      statusNone: 'No team connected yet', statusPaused: 'Paused', statusNotConnected: 'Not connected',
      statusWorking: { one: 'Working for {count} team', other: 'Working for {count} teams' },
      statusPausedCount: { one: '{count} paused', other: '{count} paused' },
      statusNeedsYou: 'Needs you: {what}',
    },
    'en-US': {
      title: 'Nessie Computer', tabs: 'Nessie Computer', overview: 'Overview', access: 'Access', documents: 'Documents',
      ai: 'AI', settings: 'Settings', team: 'Team', pauseAll: 'Pause all', resumeAll: 'Resume all',
      openNessie: 'Open Nessie', tryAgain: 'Try again', cancel: 'Cancel', close: 'Close', done: 'Done', details: 'Details',
      noTeam: 'Add this computer to a team to choose what that team may use.', addComputer: 'Add this computer',
      loadingTeam: 'Loading settings for {team}…', loadFailed: 'Couldn’t load settings for {team}.',
      teamNameUnknown: 'Team name not available yet',
      statusNone: 'No team connected yet', statusPaused: 'Paused', statusNotConnected: 'Not connected',
      statusWorking: { one: 'Working for {count} team', other: 'Working for {count} teams' },
      statusPausedCount: { one: '{count} paused', other: '{count} paused' },
      statusNeedsYou: 'Needs you: {what}',
    },
    cs: {
      title: 'Nessie Computer', tabs: 'Nessie Computer', overview: 'Přehled', access: 'Přístup', documents: 'Dokumenty',
      ai: 'AI', settings: 'Nastavení', team: 'Tým', pauseAll: 'Pozastavit vše', resumeAll: 'Obnovit vše',
      openNessie: 'Otevřít Nessie', tryAgain: 'Zkusit znovu', cancel: 'Zrušit', close: 'Zavřít', done: 'Hotovo', details: 'Podrobnosti',
      noTeam: 'Přidejte tento počítač do týmu a pak nastavte, co tým smí používat.', addComputer: 'Přidat tento počítač',
      loadingTeam: 'Načítá se nastavení týmu {team}…', loadFailed: 'Nastavení týmu {team} se nepodařilo načíst.',
      teamNameUnknown: 'Název týmu zatím není k dispozici',
      statusNone: 'Zatím není připojen žádný tým', statusPaused: 'Pozastaveno', statusNotConnected: 'Nepřipojeno',
      statusWorking: { one: 'Pracuje pro {count} tým', few: 'Pracuje pro {count} týmy', other: 'Pracuje pro {count} týmů' },
      statusPausedCount: { one: '{count} pozastavený', few: '{count} pozastavené', other: '{count} pozastavených' },
      statusNeedsYou: 'Potřebuje vás: {what}',
    },
    de: {
      title: 'Nessie Computer', tabs: 'Nessie Computer', overview: 'Übersicht', access: 'Zugriff', documents: 'Dokumente',
      ai: 'KI', settings: 'Einstellungen', team: 'Team', pauseAll: 'Alle pausieren', resumeAll: 'Alle fortsetzen',
      openNessie: 'Nessie öffnen', tryAgain: 'Erneut versuchen', cancel: 'Abbrechen', close: 'Schließen', done: 'Fertig', details: 'Details',
      noTeam: 'Fügen Sie diesen Computer einem Team hinzu, um festzulegen, was das Team nutzen darf.', addComputer: 'Diesen Computer hinzufügen',
      loadingTeam: 'Einstellungen für {team} werden geladen…', loadFailed: 'Die Einstellungen für {team} konnten nicht geladen werden.',
      teamNameUnknown: 'Teamname noch nicht verfügbar',
      statusNone: 'Noch kein Team verbunden', statusPaused: 'Pausiert', statusNotConnected: 'Nicht verbunden',
      statusWorking: { one: 'Arbeitet für {count} Team', other: 'Arbeitet für {count} Teams' },
      statusPausedCount: { one: '{count} pausiert', other: '{count} pausiert' },
      statusNeedsYou: 'Braucht Sie: {what}',
    },
    es: {
      title: 'Nessie Computer', tabs: 'Nessie Computer', overview: 'Resumen', access: 'Acceso', documents: 'Documentos',
      ai: 'IA', settings: 'Ajustes', team: 'Equipo', pauseAll: 'Pausar todo', resumeAll: 'Reanudar todo',
      openNessie: 'Abrir Nessie', tryAgain: 'Reintentar', cancel: 'Cancelar', close: 'Cerrar', done: 'Hecho', details: 'Detalles',
      noTeam: 'Añade este ordenador a un equipo para decidir qué puede usar ese equipo.', addComputer: 'Añadir este ordenador',
      loadingTeam: 'Cargando los ajustes de {team}…', loadFailed: 'No se pudieron cargar los ajustes de {team}.',
      teamNameUnknown: 'Nombre del equipo aún no disponible',
      statusNone: 'Todavía no hay ningún equipo conectado', statusPaused: 'En pausa', statusNotConnected: 'Sin conexión',
      statusWorking: { one: 'Trabajando para {count} equipo', other: 'Trabajando para {count} equipos' },
      statusPausedCount: { one: '{count} en pausa', other: '{count} en pausa' },
      statusNeedsYou: 'Te necesita: {what}',
    },
    fr: {
      title: 'Nessie Computer', tabs: 'Nessie Computer', overview: 'Aperçu', access: 'Accès', documents: 'Documents',
      ai: 'IA', settings: 'Réglages', team: 'Équipe', pauseAll: 'Tout mettre en pause', resumeAll: 'Tout reprendre',
      openNessie: 'Ouvrir Nessie', tryAgain: 'Réessayer', cancel: 'Annuler', close: 'Fermer', done: 'Terminé', details: 'Détails',
      noTeam: 'Ajoutez cet ordinateur à une équipe pour choisir ce qu’elle peut utiliser.', addComputer: 'Ajouter cet ordinateur',
      loadingTeam: 'Chargement des réglages de {team}…', loadFailed: 'Impossible de charger les réglages de {team}.',
      teamNameUnknown: 'Nom de l’équipe pas encore disponible',
      statusNone: 'Aucune équipe connectée pour l’instant', statusPaused: 'En pause', statusNotConnected: 'Non connecté',
      statusWorking: { one: 'Au travail pour {count} équipe', other: 'Au travail pour {count} équipes' },
      statusPausedCount: { one: '{count} en pause', other: '{count} en pause' },
      statusNeedsYou: 'Besoin de vous : {what}',
    },
    it: {
      title: 'Nessie Computer', tabs: 'Nessie Computer', overview: 'Panoramica', access: 'Accesso', documents: 'Documenti',
      ai: 'IA', settings: 'Impostazioni', team: 'Team', pauseAll: 'Sospendi tutto', resumeAll: 'Riprendi tutto',
      openNessie: 'Apri Nessie', tryAgain: 'Riprova', cancel: 'Annulla', close: 'Chiudi', done: 'Fatto', details: 'Dettagli',
      noTeam: 'Aggiungi questo computer a un team per scegliere cosa può usare quel team.', addComputer: 'Aggiungi questo computer',
      loadingTeam: 'Caricamento delle impostazioni di {team}…', loadFailed: 'Impossibile caricare le impostazioni di {team}.',
      teamNameUnknown: 'Nome del team non ancora disponibile',
      statusNone: 'Nessun team ancora connesso', statusPaused: 'In pausa', statusNotConnected: 'Non connesso',
      statusWorking: { one: 'Al lavoro per {count} team', other: 'Al lavoro per {count} team' },
      statusPausedCount: { one: '{count} in pausa', other: '{count} in pausa' },
      statusNeedsYou: 'Ha bisogno di te: {what}',
    },
  })
})()
