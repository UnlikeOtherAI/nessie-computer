// The installer cannot be built anywhere but Windows with the WiX toolset, so
// these are the parts that can be checked everywhere: the port-to-GUID rule the
// Hyper-V registration depends on, the ProductVersion rules Windows Installer
// enforces silently, and the agreement between this plan and the authoring
// beside it.
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { sealWindowsLaunchConsumers } from './launch-consumers.mjs'

import {
  BUILT_BINARIES,
  GUEST_CONSOLE_PORT,
  GUEST_CONTROL_PORT,
  GUEST_EGRESS_PORT,
  HYPERV_SOCKET_PORTS,
  RESOURCE_FILES,
  HYPERV_ADMINISTRATORS_SID,
  HYPERV_SOCKET_ELEMENT_NAME,
  HYPERV_SOCKET_REGISTRY_KEY,
  INSTALLED_FILES,
  SERVICE_ACCOUNT,
  SERVICE_DISPLAY_NAME,
  SERVICE_NAME,
  hyperVSocketServiceGuid,
  msiFileName,
  msiVersion,
} from './msi-plan.mjs'

const packaging = dirname(fileURLToPath(import.meta.url))
const authoring = await readFile(join(packaging, 'nessie-executor.wxs'), 'utf8')
const buildScript = await readFile(join(packaging, 'build-msi.mjs'), 'utf8')
const script = async (name) => readFile(join(packaging, 'scripts', name), 'utf8')

test('the personal installed floor binds the final signed service and tray, refusing incomplete producers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-consumer-manifest-'))
  try {
    const manifest = { format: 1, managedRuntimeGuardVersion: 2, nativeHelper: 'nessie-executor-native.exe' }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
    await assert.rejects(sealWindowsLaunchConsumers(directory))
    await writeFile(join(directory, 'nessie-executor-service.exe'), 'signed-service-bytes-fixture')
    await writeFile(join(directory, 'nessie-executor-tray.exe'), 'signed-tray-bytes-fixture')
    const sealed = await sealWindowsLaunchConsumers(directory)
    assert.equal(sealed.serviceSha256, createHash('sha256').update('signed-service-bytes-fixture').digest('hex'))
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')),
      { ...manifest, windowsLaunchConsumers: sealed })
    await writeFile(join(directory, 'nessie-executor-tray.exe'), 'replaced-signed-tray-bytes-fixture')
    assert.notEqual((await sealWindowsLaunchConsumers(directory)).traySha256, sealed.traySha256)
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...manifest, managedRuntimeGuardVersion: 1 }))
    await assert.rejects(sealWindowsLaunchConsumers(directory), /managed native runtime/u)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('the tray build uses the supported no-installer option', () => {
  assert.ok(buildScript.includes("'tauri', 'build', '--no-bundle'"))
  assert.equal(buildScript.includes("'--bundles', 'none'"), false)
})

test('WiX builds first and validates with the intended ICE exceptions', () => {
  assert.ok(buildScript.includes("const WIX_VERSION = '5.0.2'"))
  assert.ok(buildScript.includes("'msi', 'validate',"))
  assert.ok(buildScript.includes("'-sice', 'ICE38',"))
  assert.ok(buildScript.includes("'-sice', 'ICE64',"))
  assert.equal(buildScript.includes("'-sice:ICE38'"), false)
  assert.equal(buildScript.includes("'-sice:ICE64'"), false)
  assert.ok(buildScript.indexOf("'build',") < buildScript.indexOf("'msi', 'validate',"))
})

/**
 * The dialog set is a separate install from the toolset, so a workflow that
 * installs `wix` and stops there builds everything right up to the `ui:WixUI`
 * element and then fails with WIX0144 — an error that names an extension
 * rather than anything a reader would connect to the installer's appearance.
 */
test('the WiX UI extension is pinned to the package toolset version', () => {
  const extension = buildScript.match(/const UI_EXTENSION = `([^`]+)`/)?.[1]
  assert.equal(extension, 'WixToolset.UI.wixext/${WIX_VERSION}')
})

test('a Hyper-V socket GUID is the guest port in the VSOCK template', () => {
  // Microsoft's own worked example: port 2761 is 0x00000ac9.
  assert.equal(hyperVSocketServiceGuid(2761), '00000ac9-facb-11e6-bd58-64006a7986d3')
  assert.equal(hyperVSocketServiceGuid(0), '00000000-facb-11e6-bd58-64006a7986d3')
  assert.equal(
    hyperVSocketServiceGuid(GUEST_CONTROL_PORT),
    '0000c000-facb-11e6-bd58-64006a7986d3',
  )
  for (const port of [-1, 1.5, 'ac9', 0x1_0000_0000]) {
    assert.throws(() => hyperVSocketServiceGuid(port), /not a Hyper-V socket port/)
  }
})

test('every guest port the host opens a socket to is registered', () => {
  // An unregistered GUID does not fail: the socket simply never opens, and the
  // session dies waiting for a guest that could not reach it.
  assert.deepEqual(HYPERV_SOCKET_PORTS, [GUEST_CONSOLE_PORT, GUEST_CONTROL_PORT, GUEST_EGRESS_PORT])
  assert.deepEqual(HYPERV_SOCKET_PORTS.map(hyperVSocketServiceGuid), [
    '0000bfff-facb-11e6-bd58-64006a7986d3',
    '0000c000-facb-11e6-bd58-64006a7986d3',
    '0000c001-facb-11e6-bd58-64006a7986d3',
  ])
  for (const port of HYPERV_SOCKET_PORTS) {
    assert.ok(
      authoring.includes(hyperVSocketServiceGuid(port)),
      `port ${port} must be registered`,
    )
  }
})

test('every sandbox resource has a component, and nothing else is installed', () => {
  for (const name of RESOURCE_FILES) {
    assert.ok(
      authoring.includes(`Source="$(var.StagingDir)\\resources\\${name}"`),
      `${name} must be installed by the authoring`,
    )
  }
  // The package ships no conditional component group: the guest's FAT32 boot
  // disk is written by the executor itself, so there is no external filesystem
  // tool a release might or might not have staged.
  assert.equal(/<\?ifdef/.test(authoring), false, 'the authoring must be unconditional')
  // `manifest.json` is installed beside them and excluded from its own listing.
  const sources = [...authoring.matchAll(/Source="\$\(var\.StagingDir\)\\resources\\([^"]+)"/g)]
  assert.deepEqual(
    sources.map((match) => match[1]).sort(),
    [...RESOURCE_FILES, 'manifest.json'].sort(),
  )
})

test('the pinned scripts refuse a profile, a prompt, and a partial failure', async () => {
  for (const name of ['create.ps1', 'remove.ps1', 'start.ps1', 'stop.ps1']) {
    const body = await script(name)
    assert.ok(body.includes("Set-StrictMode -Version Latest"), `${name} must be strict`)
    assert.ok(body.includes("$ErrorActionPreference = 'Stop'"), `${name} must stop on error`)
    assert.ok(body.includes('[CmdletBinding()]'), `${name} must declare its parameters`)
    // Nothing is composed and re-parsed: a value arrives as a bound parameter.
    assert.equal(/Invoke-Expression|iex\s/.test(body), false, `${name} must not evaluate text`)
  }
})

test('the created machine has no network adapter and no Secure Boot', async () => {
  const body = await script('create.ps1')
  // New-VM always makes one adapter, so not connecting it is not enough.
  assert.ok(body.includes('Remove-VMNetworkAdapter'))
  assert.equal(body.includes('-SwitchName'), false)
  assert.equal(body.includes('Connect-VMNetworkAdapter'), false)
  // A kernel built here is signed by nobody in the UEFI database.
  assert.ok(body.includes('-EnableSecureBoot Off'))
  assert.ok(body.includes('-Generation 2'))
  // Generation 2 refuses VHD, so each fixed VHD becomes VHDX before it is
  // attached, and only on the SCSI controller a generation 2 machine has.
  assert.ok(body.includes('Convert-VHD'))
  assert.ok(body.includes('-VHDType Fixed'))
  assert.ok(body.includes('-ControllerType SCSI'))
  assert.equal(body.includes('ControllerType IDE'), false)
  // A checkpoint would write the session's workspace somewhere it outlives the
  // session.
  assert.ok(body.includes('-AutomaticCheckpointsEnabled $false'))
})

test('stopping is the control channel first, and turning the power off only after', async () => {
  const body = await script('stop.ps1')
  // Stop-VM asks the guest through the shutdown integration service, which an
  // initramfs does not run; -TurnOff is what the daemon's timeout falls to.
  assert.ok(body.includes("ValidateSet('shutdown', 'turnoff')"))
  assert.ok(body.includes('-TurnOff'))
  // A machine that is already gone is success: stop runs on every failure path.
  assert.ok(body.includes('-ErrorAction SilentlyContinue'))
})

test('the registered GUID is the one derived from the guest control port', () => {
  // A GUID typed into the authoring by hand would register a service the guest
  // never connects on, and nothing would report it: the socket simply never
  // opens.
  assert.ok(authoring.includes(hyperVSocketServiceGuid(GUEST_CONTROL_PORT)))
  assert.ok(authoring.includes(HYPERV_SOCKET_REGISTRY_KEY))
  assert.ok(authoring.includes(`Value="${HYPERV_SOCKET_ELEMENT_NAME}"`))
})

test('a ProductVersion is three numbers inside Windows Installer’s limits', () => {
  assert.equal(msiVersion('0.1.0'), '0.1.0')
  assert.equal(msiVersion(' 12.7.4096 '), '12.7.4096')
  for (const declared of [
    '',
    '1.2',
    '1.2.3.4',
    // A fourth field is ignored by Windows Installer's upgrade comparison, and
    // a prerelease suffix has nowhere to go at all.
    '1.2.3-rc.1',
    'v1.2.3',
    '256.0.0',
    '0.256.0',
    '0.0.65536',
  ]) {
    assert.throws(() => msiVersion(declared), /ProductVersion/, `${declared} must be refused`)
  }
})

test('the installer file name states its version and architecture', () => {
  assert.equal(msiFileName('0.1.0'), 'NessieExecutor_0.1.0_x64.msi')
  assert.throws(() => msiFileName('0.1.0-rc.1'), /ProductVersion/)
})

test('every planned file has a component in the authoring', () => {
  for (const name of INSTALLED_FILES) {
    assert.ok(
      authoring.includes(`Source="$(var.StagingDir)\\${name}"`),
      `${name} must be installed by the authoring`,
    )
  }
  for (const name of BUILT_BINARIES) {
    assert.ok(INSTALLED_FILES.includes(name), `${name} must also be an installed file`)
  }
})

test('the service is registered under its own virtual account and starts at boot', () => {
  assert.ok(authoring.includes(`Name="${SERVICE_NAME}"`))
  assert.ok(authoring.includes(`DisplayName="${SERVICE_DISPLAY_NAME}"`))
  assert.ok(authoring.includes(`Account="${SERVICE_ACCOUNT}"`))
  assert.ok(authoring.includes('Start="auto"'))
  // No password element anywhere: a virtual account has none, and one here
  // would mean the account is not virtual at all.
  assert.ok(!authoring.includes('Password='))
})

test('the group membership runs after the service exists and never fails the install', () => {
  assert.ok(authoring.includes('ExeCommand="--join-hyperv-administrators"'))
  assert.ok(authoring.includes('After="StartServices"'))
  // Windows editions without Hyper-V have no such group; the executor still
  // installs and still serves the workspace bundle.
  assert.ok(/Id="JoinHypervAdministrators"[\s\S]*?Return="ignore"/.test(authoring))
  // The alias is named by SID in the code that joins it, because its display
  // name is localized; the authoring must not hardcode an English group name.
  assert.ok(!authoring.includes('Hyper-V Administrators"'))
  assert.equal(HYPERV_ADMINISTRATORS_SID, 'S-1-5-32-578')
})

test('the state root is created and never removed', () => {
  assert.ok(authoring.includes('Id="ExecutorStateDirectory"'))
  assert.ok(authoring.includes('<CreateFolder />'))
  // RemoveFolder would take a paired executor's machine key with it.
  assert.ok(!authoring.includes('<RemoveFolder'))
  assert.ok(authoring.includes('Id="SecureServiceStateRoot"'))
  assert.ok(/Id="SecureServiceStateRoot"[\s\S]*?Impersonate="no"[\s\S]*?Return="check"/.test(authoring))
  assert.ok(authoring.includes('Action="SecureServiceStateRoot" After="InstallServices"'))
  // One action establishes all three directories, and it runs the service
  // binary. The helper would do the same job, but it is a console program, so
  // calling it here drew a black window per directory in the middle of an
  // install; the service binary has no console and runs the helper with its
  // output piped. The executors and pending roots are therefore no longer
  // separate actions — `--secure-state-root` derives all three itself.
  assert.ok(/Id="SecureServiceStateRoot"[\s\S]*?FileRef="ServiceExe"/.test(authoring))
  assert.ok(/Id="SecureServiceStateRoot"[\s\S]*?ExeCommand="--secure-state-root"/.test(authoring))
  for (const id of ['SecureServiceExecutorsRoot', 'SecureServicePendingRoot']) {
    assert.ok(!authoring.includes(`Id="${id}"`), `${id} was folded into --secure-state-root`)
  }
})

/**
 * The anti-flash guarantee, as a property rather than a spelling: no custom
 * action may run the packaged native helper. It is a console program by design
 * — a person can run it by hand and read its JSON — so every console window an
 * install drew came from naming it here.
 */
test('no custom action runs a console program', () => {
  const actions = authoring.match(/<CustomAction[\s\S]*?\/>/g) ?? []
  assert.ok(actions.length > 0, 'the authoring must declare custom actions')
  for (const action of actions) {
    assert.ok(
      !action.includes('FileRef="NativeHelper"'),
      `a custom action runs the console helper: ${action.replace(/\s+/g, ' ').trim()}`,
    )
  }
})

test('the authoring declares one WiX package and both preprocessor variables', () => {
  // Well-formedness is the WiX compiler's own first check, and it is the one
  // thing that cannot fail silently; what a test can usefully add is that the
  // two values `build-msi.mjs` passes are the two the authoring reads.
  assert.equal(authoring.match(/<Package\b/g)?.length, 1)
  assert.ok(authoring.includes('$(var.Version)'))
  assert.ok(authoring.includes('$(var.StagingDir)'))
  assert.ok(authoring.includes('xmlns="http://wixtoolset.org/schemas/v4/wxs"'))
})
