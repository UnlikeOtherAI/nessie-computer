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

  // The shell's own words: window title, tabs, the team row, the Needs you strip's name and the footer.
  register('shell', {
    'en-GB': {
      title: 'Nessie Computer', tabs: 'Nessie Computer', access: 'Access', documents: 'Documents', ai: 'AI', settings: 'Settings',
      team: 'Team', addTeam: 'Add another team', needsYou: 'Needs you', help: 'What this does',
      openNessie: 'Open Nessie', tryAgain: 'Try again', cancel: 'Cancel', close: 'Close', done: 'Done', details: 'Details',
      loadingTeam: 'Loading {team}…', loadFailed: 'Couldn’t load {team}.', teamNameUnknown: 'Team name not available yet',
    },
    'en-US': {
      title: 'Nessie Computer', tabs: 'Nessie Computer', access: 'Access', documents: 'Documents', ai: 'AI', settings: 'Settings',
      team: 'Team', addTeam: 'Add another team', needsYou: 'Needs you', help: 'What this does',
      openNessie: 'Open Nessie', tryAgain: 'Try again', cancel: 'Cancel', close: 'Close', done: 'Done', details: 'Details',
      loadingTeam: 'Loading {team}…', loadFailed: 'Couldn’t load {team}.', teamNameUnknown: 'Team name not available yet',
    },
    cs: {
      title: 'Nessie Computer', tabs: 'Nessie Computer', access: 'Přístup', documents: 'Dokumenty', ai: 'AI', settings: 'Nastavení',
      team: 'Tým', addTeam: 'Přidat další tým', needsYou: 'Potřebuje vás', help: 'K čemu to je',
      openNessie: 'Otevřít Nessie', tryAgain: 'Zkusit znovu', cancel: 'Zrušit', close: 'Zavřít', done: 'Hotovo', details: 'Podrobnosti',
      loadingTeam: 'Načítá se {team}…', loadFailed: 'Tým {team} se nepodařilo načíst.', teamNameUnknown: 'Název týmu zatím není k dispozici',
    },
    de: {
      title: 'Nessie Computer', tabs: 'Nessie Computer', access: 'Zugriff', documents: 'Dokumente', ai: 'KI', settings: 'Einstellungen',
      team: 'Team', addTeam: 'Weiteres Team hinzufügen', needsYou: 'Braucht Sie', help: 'Was das bewirkt',
      openNessie: 'Nessie öffnen', tryAgain: 'Erneut versuchen', cancel: 'Abbrechen', close: 'Schließen', done: 'Fertig', details: 'Details',
      loadingTeam: '{team} wird geladen…', loadFailed: '{team} konnte nicht geladen werden.', teamNameUnknown: 'Teamname noch nicht verfügbar',
    },
    es: {
      title: 'Nessie Computer', tabs: 'Nessie Computer', access: 'Acceso', documents: 'Documentos', ai: 'IA', settings: 'Ajustes',
      team: 'Equipo', addTeam: 'Añadir otro equipo', needsYou: 'Te necesita', help: 'Qué hace esto',
      openNessie: 'Abrir Nessie', tryAgain: 'Reintentar', cancel: 'Cancelar', close: 'Cerrar', done: 'Hecho', details: 'Detalles',
      loadingTeam: 'Cargando {team}…', loadFailed: 'No se pudo cargar {team}.', teamNameUnknown: 'Nombre del equipo aún no disponible',
    },
    fr: {
      title: 'Nessie Computer', tabs: 'Nessie Computer', access: 'Accès', documents: 'Documents', ai: 'IA', settings: 'Réglages',
      team: 'Équipe', addTeam: 'Ajouter une autre équipe', needsYou: 'Besoin de vous', help: 'À quoi ça sert',
      openNessie: 'Ouvrir Nessie', tryAgain: 'Réessayer', cancel: 'Annuler', close: 'Fermer', done: 'Terminé', details: 'Détails',
      loadingTeam: 'Chargement de {team}…', loadFailed: 'Impossible de charger {team}.', teamNameUnknown: 'Nom de l’équipe pas encore disponible',
    },
    it: {
      title: 'Nessie Computer', tabs: 'Nessie Computer', access: 'Accesso', documents: 'Documenti', ai: 'IA', settings: 'Impostazioni',
      team: 'Team', addTeam: 'Aggiungi un altro team', needsYou: 'Ha bisogno di te', help: 'A cosa serve',
      openNessie: 'Apri Nessie', tryAgain: 'Riprova', cancel: 'Annulla', close: 'Chiudi', done: 'Fatto', details: 'Dettagli',
      loadingTeam: 'Caricamento di {team}…', loadFailed: 'Impossibile caricare {team}.', teamNameUnknown: 'Nome del team non ancora disponibile',
    },
  })
})()
