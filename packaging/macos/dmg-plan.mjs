// The facts the macOS installer is built from, kept apart from the building so
// they can be asserted on any host. `build-dmg.mjs` runs only on macOS, with
// Xcode's command line tools and — for anything it is allowed to call
// installable — a `Developer ID Application` certificate and notary
// credentials. Everything decided here is decided the same way everywhere, and
// `dmg-plan.test.mjs` is where it is checked.
//
// The rule this file exists to make unbypassable is
// docs/standards/build-and-release.md → "macOS release-signing policy": an
// ad-hoc signature is never a distributable one. The build therefore has two
// outcomes and no third: a signed, notarized, stapled DMG, or an artifact whose
// own name says it may not be installed by anyone.

/**
 * The app the DMG carries is built by the app's own directory. The contract is
 * exactly this: the script accepts `--configuration` and `--output`, and prints
 * the absolute path of the built `.app` as the last line of its stdout. Nothing
 * else about the app's build is this package's business.
 */
export const BUILD_APP_SCRIPT = 'menubar-macos/scripts/build-app.sh'

/**
 * The message a host without that script gets. The installer pipeline is
 * deliberately buildable — and testable — before the app lands, so this is a
 * named, expected state rather than a stack trace about a missing file.
 */
export const missingBuildScriptMessage = (path) => (
  `The menu bar app's build script is not at ${path}. `
  + `The installer expects ${BUILD_APP_SCRIPT} to accept `
  + '[--configuration Release] [--output <dir>] and to print the absolute path of the built '
  + '.app as the last line of its stdout. Until the app lands, only this package\'s plan can be '
  + 'checked: node --test executor/packaging/macos/dmg-plan.test.mjs'
)

/**
 * Every bundle identifier this package will package must sit under the
 * namespace the other Nessie desktop-family bundles use
 * (`com.unlikeotherai.nessie.desktop`, `com.unlikeotherai.nessie.executor.tray`).
 * The exact suffix belongs to the app, but the namespace does not: Gatekeeper,
 * `SMAppService` launch-at-login registration and the app's private
 * application-support directory are all keyed by this identifier, so packaging
 * a bundle identified as something else would ship a different application
 * under this one's name.
 */
export const APP_BUNDLE_IDENTIFIER_PREFIX = 'com.unlikeotherai.nessie.'

export const assertBundleIdentifier = (identifier) => {
  const value = String(identifier ?? '').trim()
  if (!value.startsWith(APP_BUNDLE_IDENTIFIER_PREFIX)) {
    throw new Error(
      `The app's CFBundleIdentifier is "${value || '(none)'}", which is outside the Nessie `
      + `namespace ${APP_BUNDLE_IDENTIFIER_PREFIX}*. The installer will not package an app `
      + 'identified as something else: Gatekeeper, launch-at-login and the app\'s private state '
      + 'directory are all keyed by this identifier.',
    )
  }
  return value
}

/**
 * Where the packaged executor runtime goes inside the app: the same relative
 * path the desktop bundle uses, so one habit answers "where is the CLI this app
 * shells out to" on both. `executor/scripts/prepare-runtime.mjs` is its only
 * producer — the pinned Node, the bundled CLI, the licence and the sha256
 * manifest all come from that one call, never from a copy of its logic.
 */
export const EXECUTOR_RUNTIME_DIRECTORY = 'Contents/Resources/executor-runtime'

/** The staged root the DMG is made from: the app, and the drop target. */
export const APPLICATIONS_SYMLINK_NAME = 'Applications'
export const APPLICATIONS_SYMLINK_TARGET = '/Applications'

/**
 * Hardened runtime is not optional for a notarized build, and a hardened Node
 * cannot allocate the executable memory V8 needs unless it is told it may. Those
 * entitlements are therefore the packaged runtime's, not the app's: they are
 * granted to the one binary that needs them rather than to the whole bundle,
 * which is why there are two entitlement files here at all.
 */
export const APP_ENTITLEMENTS_FILE = 'nessie-executor-menubar.entitlements'
export const RUNTIME_ENTITLEMENTS_FILE = 'packaged-node.entitlements'

/**
 * Signing is inside-out: a nested Mach-O signed after its container invalidates
 * the container's seal, so every binary the bundle carries is signed before the
 * bundle is. `codesign --deep` is deliberately never used to *sign* — Apple
 * documents it as unsuitable for anything needing per-binary entitlements, which
 * is exactly this bundle's shape. It is only ever used to verify.
 */
export const codesignArguments = ({ entitlements, identity, path, timestamp = true }) => {
  if (!identity || identity === '-') {
    throw new Error(
      'A distributable macOS signature is a Developer ID Application identity. '
      + 'An ad-hoc identity ("-") is refused here by policy '
      + '(docs/standards/build-and-release.md → macOS release-signing policy).',
    )
  }
  return [
    '--force',
    '--sign', identity,
    '--options', 'runtime',
    ...(timestamp ? ['--timestamp'] : []),
    ...(entitlements === undefined ? [] : ['--entitlements', entitlements]),
    path,
  ]
}

/** What `codesign --verify` is asked, and it is asked of every build. */
export const codesignVerifyArguments = (path) => ['--verify', '--deep', '--strict', '--verbose=2', path]

/**
 * `codesign -dvv` writes its report as `Key=value` lines. Two of them decide
 * whether this is a build anyone may install: the leaf authority must be a
 * Developer ID Application certificate, and the team must be the one the release
 * is configured for. Checking only the first would accept another developer's
 * valid Developer ID; checking only the second would accept this team's Mac App
 * Store certificate, which deliberately cannot carry the executor runtime.
 */
export const assertDeveloperIdSignature = (codesignReport, teamId) => {
  const lines = String(codesignReport).split('\n').map((line) => line.trim())
  const first = (key) => {
    const match = lines
      .map((line) => new RegExp(`^${key}=(.*)$`).exec(line))
      .find((candidate) => candidate !== null)
    return match === undefined || match === null ? undefined : match[1]
  }
  const authority = first('Authority')
  if (first('Signature') === 'adhoc' || authority === undefined) {
    throw new Error(
      'The bundle is ad-hoc signed, or carries no certificate chain at all. An ad-hoc signature '
      + 'is never a distributable one (docs/standards/build-and-release.md → macOS '
      + 'release-signing policy).',
    )
  }
  if (!authority.startsWith('Developer ID Application:')) {
    throw new Error(
      `The bundle's leaf authority is "${authority}", not a Developer ID Application certificate. `
      + 'A Mac App Store or Apple Development certificate is not a substitute.',
    )
  }
  const teamIdentifier = first('TeamIdentifier')
  if (teamIdentifier !== teamId) {
    throw new Error(
      `The bundle is signed by team ${teamIdentifier ?? '(none)'}, not the configured ${teamId}.`,
    )
  }
  return { authority, teamIdentifier }
}

/**
 * The environment variables the signed path needs, and nothing more.
 *
 * `NESSIE_EXECUTOR_SIGNING_IDENTITY` already means "the identity the executor's
 * macOS artifacts are signed with" (executor/vm/scripts/build-signed-vm-helper.sh),
 * and `NESSIE_DESKTOP_SIGNING_TEAM_ID` already means "the trusted Apple
 * Developer team" across desktop and executor packaging alike
 * (desktop/scripts/require-signing-team.mjs,
 * executor/scripts/prepare-chrome-cookie-import.mjs). Inventing a third and a
 * fourth name for the same two facts would be the real inconsistency.
 */
export const SIGNING_IDENTITY_VARIABLE = 'NESSIE_EXECUTOR_SIGNING_IDENTITY'
export const SIGNING_TEAM_VARIABLE = 'NESSIE_DESKTOP_SIGNING_TEAM_ID'

/**
 * Notary credentials come in Apple's own two shapes, and notarytool takes one or
 * the other — never a mixture. An App Store Connect API key is the shape CI
 * should use: it is scoped, revocable on its own, and carries no Apple ID
 * password. The Apple ID shape exists because a person signing a build on their
 * own Mac usually has that and not a key.
 *
 * The names are Apple's where Apple has one. `APP_STORE_CONNECT_API_KEY_ID` and
 * `APP_STORE_CONNECT_API_ISSUER_ID` are already this repository's spelling
 * (.github/workflows/publish-apple-testflight.yml); `..._KEY_PATH` is added
 * because notarytool reads the `.p8` from disk, while that workflow's existing
 * `APP_STORE_CONNECT_API_KEY_P8_BASE64` secret is what gets decoded into it.
 */
export const NOTARY_API_KEY_VARIABLES = [
  'APP_STORE_CONNECT_API_KEY_ID',
  'APP_STORE_CONNECT_API_ISSUER_ID',
  'APP_STORE_CONNECT_API_KEY_PATH',
]

export const NOTARY_APPLE_ID_VARIABLES = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD']

/** Opting a build out of signing has to be said out loud, and only locally. */
export const DEVELOPMENT_OPT_OUT_VARIABLE = 'NESSIE_EXECUTOR_DMG_UNSIGNED_DEVELOPMENT'

const present = (environment, name) => {
  const value = environment[name]
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * The notarytool arguments for whichever credential shape is complete, or a
 * refusal naming every variable missing from the shape that came closest. A
 * half-supplied shape is the dangerous case: it is what a typo in one secret
 * looks like, and quietly falling back to "no notarization" would publish a DMG
 * that Gatekeeper blocks on every machine that has never seen it.
 */
export const notaryCredentials = (environment, teamId) => {
  const apiKeyPresent = NOTARY_API_KEY_VARIABLES.filter((name) => present(environment, name))
  const appleIdPresent = NOTARY_APPLE_ID_VARIABLES.filter((name) => present(environment, name))

  if (apiKeyPresent.length === NOTARY_API_KEY_VARIABLES.length) {
    return {
      arguments: [
        '--key', environment.APP_STORE_CONNECT_API_KEY_PATH,
        '--key-id', environment.APP_STORE_CONNECT_API_KEY_ID,
        '--issuer', environment.APP_STORE_CONNECT_API_ISSUER_ID,
      ],
      kind: 'api-key',
    }
  }
  if (appleIdPresent.length === NOTARY_APPLE_ID_VARIABLES.length) {
    if (!teamId) {
      throw new Error(
        `Notarizing with an Apple ID needs the team as well. Set ${SIGNING_TEAM_VARIABLE}.`,
      )
    }
    return {
      arguments: [
        '--apple-id', environment.APPLE_ID,
        '--password', environment.APPLE_APP_SPECIFIC_PASSWORD,
        '--team-id', teamId,
      ],
      kind: 'apple-id',
    }
  }

  const partial = apiKeyPresent.length >= appleIdPresent.length
    ? {
      missing: NOTARY_API_KEY_VARIABLES.filter((name) => !present(environment, name)),
      name: 'App Store Connect API key',
    }
    : {
      missing: NOTARY_APPLE_ID_VARIABLES.filter((name) => !present(environment, name)),
      name: 'Apple ID',
    }
  throw new Error(
    'Notary credentials are incomplete. Supply either the App Store Connect API key '
    + `(${NOTARY_API_KEY_VARIABLES.join(', ')}) or the Apple ID `
    + `(${NOTARY_APPLE_ID_VARIABLES.join(', ')} with ${SIGNING_TEAM_VARIABLE}). `
    + `The ${partial.name} shape is missing: ${partial.missing.join(', ')}.`,
  )
}

/**
 * Which of the two builds this invocation is, decided before anything is built
 * so a missing certificate is a first-second failure rather than a surprise
 * after a long compile.
 *
 * There is no degrading. `requireSigned` — what CI always passes — turns a
 * missing credential into a refusal; without it, a credential-less host still
 * has to ask for the development build by name, and gets an artifact that says
 * what it is.
 */
export const resolveBuildMode = (environment, { requireSigned = false } = {}) => {
  const identity = environment[SIGNING_IDENTITY_VARIABLE]?.trim()
  const teamId = environment[SIGNING_TEAM_VARIABLE]?.trim()
  const optedOut = present(environment, DEVELOPMENT_OPT_OUT_VARIABLE)

  if (identity && teamId) {
    if (optedOut) {
      throw new Error(
        `${DEVELOPMENT_OPT_OUT_VARIABLE} is set on a host that has signing credentials. `
        + 'Refusing to guess which build was wanted: unset one of them.',
      )
    }
    if (identity === '-') {
      throw new Error(
        `${SIGNING_IDENTITY_VARIABLE} is "-", an ad-hoc identity. A distributable macOS build `
        + 'uses the configured Developer ID Application identity '
        + '(docs/standards/build-and-release.md → macOS release-signing policy).',
      )
    }
    return { identity, kind: 'release', notary: notaryCredentials(environment, teamId), teamId }
  }

  const missing = [
    ...(identity ? [] : [SIGNING_IDENTITY_VARIABLE]),
    ...(teamId ? [] : [SIGNING_TEAM_VARIABLE]),
  ]
  if (requireSigned) {
    throw new Error(
      `A publishable Nessie Executor DMG is signed and notarized. Missing: ${missing.join(', ')}. `
      + 'Set them to the Developer ID Application identity and its team, with notary credentials '
      + `(${NOTARY_API_KEY_VARIABLES.join(', ')} or ${NOTARY_APPLE_ID_VARIABLES.join(', ')}).`,
    )
  }
  if (!optedOut) {
    throw new Error(
      `No macOS signing credentials (${missing.join(', ')}) and no explicit development opt-in. `
      + `Set ${DEVELOPMENT_OPT_OUT_VARIABLE}=1 to build the unsigned development DMG, which is `
      + 'labelled unusable and must never be published, or supply the Developer ID credentials.',
    )
  }
  return { kind: 'development', missing }
}

/**
 * A macOS short version is one to three period-separated integers: it is what
 * goes in `CFBundleShortVersionString`, and the DMG is named after it. A
 * prerelease suffix has nowhere to live in that field, so it is refused here
 * rather than dropped into a file name that then disagrees with the bundle.
 */
export const dmgVersion = (declared) => {
  const value = String(declared ?? '').trim()
  if (!/^\d+(\.\d+){0,2}$/.test(value)) {
    throw new Error(
      `${value || '(empty)'} is not a macOS CFBundleShortVersionString `
      + '(one to three period-separated integers, digits only).',
    )
  }
  return value
}

/**
 * The version the DMG is named for is the version the app inside it reports. A
 * release that declares one and packages another would put a number on the
 * download that nothing inside it carries, and the mismatch would surface months
 * later in a support conversation.
 */
export const resolveDmgVersion = ({ bundleVersion, declared }) => {
  const bundle = dmgVersion(bundleVersion)
  if (declared === undefined || String(declared).trim() === '') return bundle
  const wanted = dmgVersion(declared)
  if (wanted !== bundle) {
    throw new Error(
      `The release declares version ${wanted} but the built app's CFBundleShortVersionString is `
      + `${bundle}. Build the app at the released version rather than renaming its installer.`,
    )
  }
  return bundle
}

/** The architectures this package builds for; Node is copied, not cross-built. */
export const DMG_ARCHITECTURES = ['arm64', 'x64']

export const dmgArchitecture = (architecture) => {
  if (!DMG_ARCHITECTURES.includes(architecture)) {
    throw new Error(
      `${architecture} is not a macOS architecture this package builds for `
      + `(${DMG_ARCHITECTURES.join(', ')}). The packaged Node is the build host's own binary, `
      + 'so the DMG is built on the architecture it is for.',
    )
  }
  return architecture
}

/**
 * The marker an unsigned build carries. It is in the file name because a file
 * name is the one thing that survives being downloaded, forwarded, renamed in a
 * release draft and pasted into a chat: whoever ends up holding this artifact is
 * told by the artifact itself.
 */
export const DEVELOPMENT_MARKER = 'UNSIGNED-DEVELOPMENT-DO-NOT-INSTALL'

export const dmgFileName = (version, architecture, mode) => {
  const base = `NessieExecutor_${dmgVersion(version)}_${dmgArchitecture(architecture)}`
  if (mode === 'release') return `${base}.dmg`
  if (mode === 'development') return `${base}-${DEVELOPMENT_MARKER}.dmg`
  throw new Error(`${mode} is not a build mode; it is "release" or "development".`)
}

/**
 * The mounted volume's name. It is what a person reads in Finder while they are
 * dragging, which is the last moment an unsigned build can still say so.
 */
export const dmgVolumeName = (version, mode) => {
  if (mode === 'release') return `Nessie Executor ${dmgVersion(version)}`
  if (mode === 'development') return `Nessie Executor ${dmgVersion(version)} — ${DEVELOPMENT_MARKER}`
  throw new Error(`${mode} is not a build mode; it is "release" or "development".`)
}

/**
 * `hdiutil` arguments for the finished image. UDZO is compressed and read-only:
 * a read-write image would let anything that mounts it rewrite the app, which is
 * the one thing the signature exists to prevent.
 */
export const hdiutilArguments = ({ output, sourceDirectory, volumeName }) => [
  'create',
  '-volname', volumeName,
  '-srcfolder', sourceDirectory,
  '-fs', 'HFS+',
  '-format', 'UDZO',
  '-imagekey', 'zlib-level=9',
  '-ov',
  output,
]

/**
 * Notarization is asked for twice, because stapling only ever attaches a ticket
 * to the thing that was submitted. Submitting the DMG alone leaves the app
 * inside it without a ticket of its own, so the first launch on a machine with
 * no network — or with Apple's service unreachable — is the one that fails. The
 * app is notarized and stapled first, then the DMG is built around the stapled
 * app and notarized in turn.
 */
export const notarizeArguments = (credentials, path) => [
  'notarytool', 'submit', path, ...credentials.arguments, '--wait',
]

export const stapleArguments = (path) => ['stapler', 'staple', path]

/**
 * Gatekeeper's own answer, asked the way the system asks it when a person
 * double-clicks a download. `--type open` with the primary-signature context is
 * the DMG question; `--type exec` is the app question. Both must pass, and a
 * pass is the only evidence that the notarization actually took effect — a
 * successful `notarytool submit` says the ticket was issued, not that this
 * artifact carries it.
 */
export const gatekeeperAssessArguments = (path, type) => {
  if (type === 'open') return ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', path]
  if (type === 'exec') return ['--assess', '--type', 'exec', '--verbose=2', path]
  throw new Error(`${type} is not a Gatekeeper assessment type; it is "open" or "exec".`)
}
