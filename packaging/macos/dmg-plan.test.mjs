// The installer cannot be built anywhere but macOS, with a certificate this
// repository's CI holds and this Mac does not, so these are the parts that can
// be checked everywhere: the refusals that keep an unsigned image from being
// called installable, the signing arguments Gatekeeper's verdict depends on, the
// layout the image is made from, and the agreement between this plan and the
// build beside it.
import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  APPLICATIONS_SYMLINK_NAME,
  APPLICATIONS_SYMLINK_TARGET,
  APP_BUNDLE_IDENTIFIER_PREFIX,
  APP_ENTITLEMENTS_FILE,
  BUILD_APP_SCRIPT,
  DEVELOPMENT_MARKER,
  DEVELOPMENT_OPT_OUT_VARIABLE,
  DMG_ARCHITECTURES,
  EXECUTOR_RUNTIME_DIRECTORY,
  NOTARY_APPLE_ID_VARIABLES,
  NOTARY_API_KEY_VARIABLES,
  RUNTIME_ENTITLEMENTS_FILE,
  SIGNING_IDENTITY_VARIABLE,
  SIGNING_TEAM_VARIABLE,
  assertBundleIdentifier,
  assertDeveloperIdSignature,
  codesignArguments,
  codesignVerifyArguments,
  dmgArchitecture,
  dmgFileName,
  dmgVersion,
  dmgVolumeName,
  gatekeeperAssessArguments,
  hdiutilArguments,
  missingBuildScriptMessage,
  notarizeArguments,
  notaryCredentials,
  resolveBuildMode,
  resolveDmgVersion,
  stapleArguments,
} from './dmg-plan.mjs'

const packaging = dirname(fileURLToPath(import.meta.url))
const repository = join(packaging, '..', '..')
const buildScript = await readFile(join(packaging, 'build-dmg.mjs'), 'utf8')
const macRuntimeProducer = await readFile(join(packaging, 'prepare-runtime.mjs'), 'utf8')
const signerScript = await readFile(join(packaging, 'sign-app.mjs'), 'utf8')
const appEntitlements = await readFile(join(packaging, APP_ENTITLEMENTS_FILE), 'utf8')
const runtimeEntitlements = await readFile(join(packaging, RUNTIME_ENTITLEMENTS_FILE), 'utf8')

const DEVELOPER_ID_REPORT = [
  'Executable=/tmp/Nessie Executor.app/Contents/MacOS/Nessie Executor',
  'Identifier=com.unlikeotherai.nessie.executor',
  'Format=app bundle with Mach-O thin (arm64)',
  'Authority=Developer ID Application: KiloMayo s.r.o. (59S95D279D)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'TeamIdentifier=59S95D279D',
  'Timestamp=16 Sep 2026 at 10:00:00',
].join('\n')

const RELEASE_ENVIRONMENT = {
  APP_STORE_CONNECT_API_ISSUER_ID: '11111111-2222-3333-4444-555555555555',
  APP_STORE_CONNECT_API_KEY_ID: 'ABCD1234EF',
  APP_STORE_CONNECT_API_KEY_PATH: '/tmp/AuthKey_ABCD1234EF.p8',
  [SIGNING_IDENTITY_VARIABLE]: 'Developer ID Application: KiloMayo s.r.o. (59S95D279D)',
  [SIGNING_TEAM_VARIABLE]: '59S95D279D',
}

test('an ad-hoc identity is refused wherever it is offered', () => {
  // The policy this package exists to keep: an ad-hoc signature is never a
  // distributable one. It is refused at the argument builder, so no caller can
  // reach codesign with "-" however it got there...
  for (const identity of ['-', '', undefined]) {
    assert.throws(
      () => codesignArguments({ identity, path: '/tmp/x.app' }),
      /Developer ID Application identity/,
    )
  }
  // ...and again at the mode resolver, where a person who exported it as the
  // signing identity is told what they actually asked for.
  assert.throws(
    () => resolveBuildMode({ ...RELEASE_ENVIRONMENT, [SIGNING_IDENTITY_VARIABLE]: '-' }),
    /ad-hoc identity/,
  )
})

test('signing arguments harden the runtime, timestamp, and carry entitlements', () => {
  assert.deepEqual(
    codesignArguments({
      entitlements: '/tmp/app.entitlements',
      identity: 'Developer ID Application: KiloMayo s.r.o. (59S95D279D)',
      path: '/tmp/Nessie Executor.app',
    }),
    [
      '--force',
      '--sign', 'Developer ID Application: KiloMayo s.r.o. (59S95D279D)',
      '--options', 'runtime',
      '--timestamp',
      '--entitlements', '/tmp/app.entitlements',
      '/tmp/Nessie Executor.app',
    ],
  )
  // Hardened runtime is not a preference: notarization refuses a submission
  // without it, so there is no argument shape here that omits it.
  const everyShape = [
    codesignArguments({ identity: 'Developer ID Application: X', path: '/a' }),
    codesignArguments({ identity: 'Developer ID Application: X', path: '/a', timestamp: false }),
  ]
  for (const shape of everyShape) {
    assert.ok(shape.includes('runtime'))
    assert.equal(shape.indexOf('--options') + 1, shape.indexOf('runtime'))
  }
})

test('a signature is read for its leaf authority AND its team', () => {
  assert.deepEqual(assertDeveloperIdSignature(DEVELOPER_ID_REPORT, '59S95D279D'), {
    authority: 'Developer ID Application: KiloMayo s.r.o. (59S95D279D)',
    teamIdentifier: '59S95D279D',
  })
  // An ad-hoc bundle reports no Authority at all, and says Signature=adhoc.
  assert.throws(
    () => assertDeveloperIdSignature(
      'Identifier=com.unlikeotherai.nessie.executor\nSignature=adhoc\n',
      '59S95D279D',
    ),
    /ad-hoc signed/,
  )
  // The Mac App Store certificate belongs to the same team and is still not a
  // substitute: that build deliberately omits the executor runtime.
  assert.throws(
    () => assertDeveloperIdSignature(
      '3rd Party Mac Developer Application is the leaf here:\n'
      + 'Authority=3rd Party Mac Developer Application: KiloMayo s.r.o. (59S95D279D)\n'
      + 'TeamIdentifier=59S95D279D\n',
      '59S95D279D',
    ),
    /not a Developer ID Application certificate/,
  )
  // This Mac's only other identity: an Apple Development certificate.
  assert.throws(
    () => assertDeveloperIdSignature(
      'Authority=Apple Development: Ondrej rafaj (JX8KZVSC4S)\nTeamIdentifier=59S95D279D\n',
      '59S95D279D',
    ),
    /not a Developer ID Application certificate/,
  )
  // Somebody else's perfectly valid Developer ID is still not ours.
  assert.throws(
    () => assertDeveloperIdSignature(
      'Authority=Developer ID Application: Someone Else (ZZ9Z9ZZ9Z9)\nTeamIdentifier=ZZ9Z9ZZ9Z9\n',
      '59S95D279D',
    ),
    /not the configured 59S95D279D/,
  )
  // A bundle with no TeamIdentifier line at all must not read as a match.
  assert.throws(
    () => assertDeveloperIdSignature(
      'Authority=Developer ID Application: KiloMayo s.r.o. (59S95D279D)\n',
      '59S95D279D',
    ),
    /signed by team \(none\)/,
  )
})

test('verification is deep and strict, and Gatekeeper is asked the real question', () => {
  assert.deepEqual(
    codesignVerifyArguments('/tmp/Nessie Executor.app'),
    ['--verify', '--deep', '--strict', '--verbose=2', '/tmp/Nessie Executor.app'],
  )
  // A DMG is assessed as something being opened, under the primary signature —
  // the same question the system asks when a person double-clicks a download.
  assert.deepEqual(
    gatekeeperAssessArguments('/tmp/x.dmg', 'open'),
    ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', '/tmp/x.dmg'],
  )
  assert.deepEqual(
    gatekeeperAssessArguments('/tmp/x.app', 'exec'),
    ['--assess', '--type', 'exec', '--verbose=2', '/tmp/x.app'],
  )
  assert.throws(() => gatekeeperAssessArguments('/tmp/x.dmg', 'install'), /assessment type/)
})

test('a complete App Store Connect key is the CI credential shape', () => {
  const credentials = notaryCredentials(RELEASE_ENVIRONMENT, '59S95D279D')
  assert.equal(credentials.kind, 'api-key')
  assert.deepEqual(credentials.arguments, [
    '--key', '/tmp/AuthKey_ABCD1234EF.p8',
    '--key-id', 'ABCD1234EF',
    '--issuer', '11111111-2222-3333-4444-555555555555',
  ])
  assert.deepEqual(
    notarizeArguments(credentials, '/tmp/x.dmg'),
    ['notarytool', 'submit', '/tmp/x.dmg', ...credentials.arguments, '--wait'],
  )
  assert.deepEqual(stapleArguments('/tmp/x.dmg'), ['stapler', 'staple', '/tmp/x.dmg'])
})

test('an Apple ID and app-specific password is the shape a person has', () => {
  const credentials = notaryCredentials(
    { APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop', APPLE_ID: 'ondrej@example.com' },
    '59S95D279D',
  )
  assert.equal(credentials.kind, 'apple-id')
  assert.deepEqual(credentials.arguments, [
    '--apple-id', 'ondrej@example.com',
    '--password', 'abcd-efgh-ijkl-mnop',
    '--team-id', '59S95D279D',
  ])
  // notarytool has no way to name the team when the Apple ID belongs to several.
  assert.throws(
    () => notaryCredentials(
      { APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop', APPLE_ID: 'ondrej@example.com' },
      '',
    ),
    new RegExp(SIGNING_TEAM_VARIABLE),
  )
})

test('a half-supplied credential names the variable that is missing', () => {
  // This is what a typo in one CI secret looks like. Falling back to "then do
  // not notarize" would publish a DMG that Gatekeeper blocks on every machine
  // that has never seen it, so the shape that came closest is reported.
  assert.throws(
    () => notaryCredentials({
      APP_STORE_CONNECT_API_ISSUER_ID: 'issuer',
      APP_STORE_CONNECT_API_KEY_ID: 'key',
    }, '59S95D279D'),
    /App Store Connect API key shape is missing: APP_STORE_CONNECT_API_KEY_PATH/,
  )
  assert.throws(
    () => notaryCredentials({ APPLE_ID: 'ondrej@example.com' }, '59S95D279D'),
    /Apple ID shape is missing: APPLE_APP_SPECIFIC_PASSWORD/,
  )
  // An empty string is missing, not supplied: an unset GitHub secret expands to
  // exactly that.
  assert.throws(
    () => notaryCredentials({ ...RELEASE_ENVIRONMENT, APP_STORE_CONNECT_API_KEY_PATH: '  ' }, '59S95D279D'),
    /missing: APP_STORE_CONNECT_API_KEY_PATH/,
  )
})

test('credentials in hand produce the release build, and nothing else does', () => {
  const mode = resolveBuildMode(RELEASE_ENVIRONMENT, { requireSigned: true })
  assert.equal(mode.kind, 'release')
  assert.equal(mode.teamId, '59S95D279D')
  assert.equal(mode.notary.kind, 'api-key')
})

test('a publishable build refuses to exist without its credentials', () => {
  // What CI passes. There is no degrading: the run fails, naming both variables.
  assert.throws(
    () => resolveBuildMode({}, { requireSigned: true }),
    new RegExp(`${SIGNING_IDENTITY_VARIABLE}, ${SIGNING_TEAM_VARIABLE}`),
  )
  assert.throws(
    () => resolveBuildMode({ [SIGNING_IDENTITY_VARIABLE]: 'Developer ID Application: X' }, { requireSigned: true }),
    new RegExp(`Missing: ${SIGNING_TEAM_VARIABLE}`),
  )
  // A signing identity with no notary credentials is not a publishable build
  // either — an unnotarized Developer ID app is still blocked on first open.
  assert.throws(
    () => resolveBuildMode({
      [SIGNING_IDENTITY_VARIABLE]: 'Developer ID Application: X',
      [SIGNING_TEAM_VARIABLE]: '59S95D279D',
    }, { requireSigned: true }),
    /Notary credentials are incomplete/,
  )
})

test('an uncredentialed host gets nothing until it asks for the development build', () => {
  // The state of a developer Mac with only an Apple Development certificate.
  assert.throws(
    () => resolveBuildMode({}),
    new RegExp(`${DEVELOPMENT_OPT_OUT_VARIABLE}=1`),
  )
  const mode = resolveBuildMode({ [DEVELOPMENT_OPT_OUT_VARIABLE]: '1' })
  assert.equal(mode.kind, 'development')
  assert.deepEqual(mode.missing, [SIGNING_IDENTITY_VARIABLE, SIGNING_TEAM_VARIABLE])
  // And it is never what a credentialed host produces by accident.
  assert.throws(
    () => resolveBuildMode({ ...RELEASE_ENVIRONMENT, [DEVELOPMENT_OPT_OUT_VARIABLE]: '1' }),
    /Refusing to guess which build was wanted/,
  )
  assert.throws(
    () => resolveBuildMode({ [DEVELOPMENT_OPT_OUT_VARIABLE]: '1' }, { requireSigned: true }),
    /publishable Nessie Executor DMG is signed and notarized/,
  )
})

test('an unsigned image says so in its file name and in Finder', () => {
  assert.equal(dmgFileName('0.1.0', 'arm64', 'release'), 'NessieExecutor_0.1.0_arm64.dmg')
  assert.equal(
    dmgFileName('0.1.0', 'arm64', 'development'),
    `NessieExecutor_0.1.0_arm64-${DEVELOPMENT_MARKER}.dmg`,
  )
  assert.equal(dmgVolumeName('0.1.0', 'release'), 'Nessie Computer 0.1.0')
  assert.ok(dmgVolumeName('0.1.0', 'development').includes(DEVELOPMENT_MARKER))
  // The marker survives being downloaded, forwarded and renamed in a release
  // draft — which is the whole reason it is in the name rather than in a log.
  assert.match(DEVELOPMENT_MARKER, /DO-NOT-INSTALL/)
  for (const mode of ['', 'signed', undefined]) {
    assert.throws(() => dmgFileName('0.1.0', 'arm64', mode), /not a build mode/)
    assert.throws(() => dmgVolumeName('0.1.0', mode), /not a build mode/)
  }
})

test('a version is a CFBundleShortVersionString, and the app decides it', () => {
  assert.equal(dmgVersion('0.1.0'), '0.1.0')
  assert.equal(dmgVersion(' 12 '), '12')
  assert.equal(dmgVersion('1.2'), '1.2')
  for (const declared of ['', '1.2.3.4', '1.2.3-rc.1', 'v1.2.3', '1.2.x', 'latest']) {
    assert.throws(() => dmgVersion(declared), /CFBundleShortVersionString/, `${declared} must be refused`)
  }
  // The name on the download and the version inside it are the same fact.
  assert.equal(resolveDmgVersion({ bundleVersion: '0.1.0', declared: '0.1.0' }), '0.1.0')
  assert.equal(resolveDmgVersion({ bundleVersion: '0.1.0', declared: undefined }), '0.1.0')
  assert.equal(resolveDmgVersion({ bundleVersion: '0.1.0', declared: '' }), '0.1.0')
  assert.throws(
    () => resolveDmgVersion({ bundleVersion: '0.1.0', declared: '0.2.0' }),
    /declares version 0.2.0 but the built app's CFBundleShortVersionString is 0.1.0/,
  )
})

test('only a Nessie-identified bundle is packaged', () => {
  assert.equal(
    assertBundleIdentifier('com.unlikeotherai.nessie.executor'),
    'com.unlikeotherai.nessie.executor',
  )
  // Gatekeeper, SMAppService launch-at-login and the app's private state
  // directory are all keyed by this identifier, so packaging someone else's
  // would ship a different application under this one's name.
  for (const identifier of ['com.example.thing', 'com.unlikeotherai.other', '', undefined]) {
    assert.throws(() => assertBundleIdentifier(identifier), /outside the Nessie namespace/)
  }
  assert.equal(APP_BUNDLE_IDENTIFIER_PREFIX, 'com.unlikeotherai.nessie.')
})

test('the image is the app and the drop target, and it is read-only', () => {
  assert.deepEqual(
    hdiutilArguments({
      output: '/tmp/x.dmg',
      sourceDirectory: '/tmp/stage',
      volumeName: 'Nessie Computer 0.1.0',
    }),
    [
      'create',
      '-volname', 'Nessie Computer 0.1.0',
      '-srcfolder', '/tmp/stage',
      '-fs', 'HFS+',
      '-format', 'UDZO',
      '-imagekey', 'zlib-level=9',
      '-ov',
      '/tmp/x.dmg',
    ],
  )
  // A read-write image would let anything that mounts it rewrite the app, which
  // is the one thing the signature exists to prevent.
  assert.ok(hdiutilArguments({ output: '/a', sourceDirectory: '/b', volumeName: 'c' }).includes('UDZO'))
  assert.equal(APPLICATIONS_SYMLINK_NAME, 'Applications')
  assert.equal(APPLICATIONS_SYMLINK_TARGET, '/Applications')
})

test('the packaged runtime has one producer and one home inside the app', () => {
  // The same relative path the desktop bundle uses.
  assert.equal(EXECUTOR_RUNTIME_DIRECTORY, 'Contents/Resources/executor-runtime')
  assert.ok(buildScript.includes("import { prepareMacExecutorRuntime } from './prepare-runtime.mjs'"))
  assert.ok(macRuntimeProducer.includes("import { prepareExecutorRuntime } from '../../scripts/prepare-runtime.mjs'"))
  // Nothing here re-derives what that producer lays down.
  assert.equal(/esbuild|copyFile\(.*execPath/.test(buildScript), false)
})

test('the build signs inside-out, and never with --deep', () => {
  // codesign --deep applies one set of entitlements to everything it reaches,
  // and the packaged Node needs two the app deliberately does not have. It is
  // used to verify and never to sign.
  assert.equal(/codesignArguments\([^)]*--deep/.test(buildScript), false)
  assert.ok(buildScript.includes("['--verify', '--deep', '--strict'") === false)
  assert.ok(codesignVerifyArguments('/a').includes('--deep'))
  // Nested binaries first, sorted deepest-first, with the main executable left
  // to the bundle signature.
  assert.ok(signerScript.includes('nestedSigningTargets'))
  assert.ok(signerScript.includes('right.split(\'/\').length - left.split(\'/\').length'))
  // The manifest is rewritten after the Node is signed and before the bundle is
  // sealed: a signature changes the bytes runtime-integrity.ts verifies, and a
  // resource edited after sealing breaks the seal.
  const manifestRewrite = signerScript.indexOf('runtime.manifestPath')
  const bundleSeal = signerScript.indexOf('codesignArguments({ entitlements: appEntitlements')
  assert.ok(manifestRewrite > 0 && bundleSeal > manifestRewrite)
})

test('both artifacts are notarized, stapled and then actually assessed', () => {
  // Stapling attaches a ticket to the thing that was submitted and to nothing
  // else, so submitting only the DMG leaves the app without one — and the first
  // launch on a machine that cannot reach Apple is the one that fails.
  assert.ok(buildScript.includes('await notarizeAndStaple(appPath, mode.notary)'))
  assert.ok(buildScript.includes('await notarizeAndStaple(packagePath, mode.notary)'))
  assert.ok(buildScript.includes("gatekeeperAssessArguments(appPath, 'exec')"))
  assert.ok(buildScript.includes("gatekeeperAssessArguments(packagePath, 'open')"))
  // A submission that is not Accepted is never stapled and never published.
  assert.ok(signerScript.includes('status:\\s*Accepted'))
  assert.ok(signerScript.includes("stapler', 'validate'"))
})

test('the two entitlement files grant JIT to the Node and to nothing else', () => {
  // A hardened Node that may not map writable-executable memory dies on its
  // first compile with a bare SIGKILL, which reads as "the daemon will not
  // start" rather than as a signing problem.
  assert.ok(runtimeEntitlements.includes('com.apple.security.cs.allow-jit'))
  assert.ok(runtimeEntitlements.includes('com.apple.security.cs.allow-unsigned-executable-memory'))
  assert.equal(/<key>com.apple.security.cs.allow-jit<\/key>\s*<true\/>/.test(appEntitlements), false)
  // Nothing injects a library into a child process.
  for (const contents of [appEntitlements, runtimeEntitlements]) {
    assert.equal(contents.includes('allow-dyld-environment-variables'), false)
  }
})

test('the app build contract is stated, and its absence is a named state', () => {
  assert.equal(BUILD_APP_SCRIPT, 'menubar-macos/scripts/build-app.sh')
  const message = missingBuildScriptMessage('/repo/executor/menubar-macos/scripts/build-app.sh')
  assert.match(message, /--configuration Release/)
  assert.match(message, /--output/)
  assert.match(message, /last line of its stdout/)
  assert.match(message, /dmg-plan\.test\.mjs/)
  // The build refuses a script that printed something that is not an .app path,
  // rather than carrying a non-path into hdiutil.
  assert.ok(buildScript.includes("lastLine.endsWith('.app')"))
})

test('the architecture is the build host’s, because the Node is', () => {
  assert.deepEqual(DMG_ARCHITECTURES, ['arm64', 'x64'])
  assert.equal(dmgArchitecture('arm64'), 'arm64')
  for (const architecture of ['x86_64', 'aarch64', 'universal', '']) {
    assert.throws(() => dmgArchitecture(architecture), /not a macOS architecture/)
  }
  // process.arch, not a flag: prepare-runtime copies the running Node binary.
  assert.ok(buildScript.includes('dmgFileName(version, process.arch, mode.kind)'))
})
