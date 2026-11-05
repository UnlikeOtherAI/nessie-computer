// A public connection choice, never an authority or a machine-key migration.
const personalPlanPairingEnglish = {
  label: 'Use my personal ChatGPT plan',
  hint: 'Use this connection for private agents on your ChatGPT plan. Keep a separate standard connection for coding tools installed under your Windows account. Windows will ask you to approve access to your Nessie folder.',
}
const personalPlanPairingWords = {
  'en-US': personalPlanPairingEnglish,
  'en-GB': personalPlanPairingEnglish,
  'cs-CZ': { label: 'Používat můj osobní tarif ChatGPT',
    hint: 'Toto připojení slouží soukromým agentům s vaším tarifem ChatGPT. Pro programovací nástroje nainstalované pod vaším účtem Windows ponechte samostatné běžné připojení. Windows vás požádá o schválení přístupu ke složce Nessie.' },
  'de-DE': { label: 'Meinen persönlichen ChatGPT-Tarif nutzen',
    hint: 'Diese Verbindung nutzt Ihren ChatGPT-Tarif für private Agenten. Behalten Sie eine separate Standardverbindung für Programmiertools Ihres Windows-Kontos. Windows bittet Sie, den Zugriff auf Ihren Nessie-Ordner zu genehmigen.' },
  'es-ES': { label: 'Usar mi plan personal de ChatGPT',
    hint: 'Esta conexión usa tu plan de ChatGPT para agentes privados. Mantén otra conexión estándar para las herramientas de programación instaladas en tu cuenta de Windows. Windows te pedirá que autorices el acceso a tu carpeta Nessie.' },
  'fr-FR': { label: 'Utiliser mon forfait ChatGPT personnel',
    hint: 'Cette connexion utilise votre forfait ChatGPT pour vos agents privés. Conservez une connexion standard distincte pour les outils de programmation de votre compte Windows. Windows vous demandera d’autoriser l’accès à votre dossier Nessie.' },
  'it-IT': { label: 'Usare il mio piano personale ChatGPT',
    hint: 'Questa connessione usa il tuo piano ChatGPT per gli agenti privati. Mantieni una connessione standard separata per gli strumenti di programmazione del tuo account Windows. Windows ti chiederà di autorizzare l’accesso alla cartella Nessie.' },
}
const pairingLocale = navigator.language.toLowerCase()
const pairingLocaleKey = Object.keys(personalPlanPairingWords).find((locale) => locale.toLowerCase() === pairingLocale)
  ?? Object.keys(personalPlanPairingWords).find((locale) => locale.toLowerCase().split('-')[0] === pairingLocale.split('-')[0])
window.executorPairingWords = personalPlanPairingWords[pairingLocaleKey] ?? personalPlanPairingEnglish
