// The facts the Windows installer is built from, kept apart from the building
// so they can be asserted on any host. `build-msi.mjs` runs only on Windows with
// the WiX toolset present; everything decided here is decided the same way
// everywhere, and `msi-plan.test.mjs` is where it is checked.

/**
 * Every file `C:\Program Files\Nessie Executor\` carries. The first four are the
 * packaged runtime that `executor/scripts/prepare-runtime.mjs` lays down and
 * that all three readers verify against `manifest.json`; the last three are the
 * Windows binaries this package adds.
 */
export const INSTALLED_FILES = [
  'nessie-executor-runtime.exe',
  'nessie-executor.cjs',
  'manifest.json',
  'NODE_LICENSE',
  'nessie-executor-native.exe',
  'nessie-computer-updater.exe',
  'nessie-executor-service.exe',
  'nessie-executor-tray.exe',
  // The command line on the machine PATH, under its name and its older one.
  'nessie-computer.cmd',
  'nessie-executor.cmd',
]

/**
 * Everything the Hyper-V sandbox backend resolves at session start, installed
 * under `resources\` beside the program. The executor's stored `vmHelperPath`
 * is `resources\nessie-hyperv-bridge.exe`, and the backend finds the pinned
 * scripts as its siblings — the same "find it beside me" rule the Linux
 * package's `build-initrd` uses to find `init`. The guest's FAT32 boot disk is
 * written in-process by the executor itself, so no filesystem tool ships here.
 * `kernelPath` is
 * `resources\guest\bzImage` and `guestInitrdBuilderPath` is
 * `resources\guest\build-initrd.exe`.
 *
 * Each file's SHA-256 is recorded in `resources\manifest.json`, exactly as the
 * Linux package records its own, and the backend refuses to run a PowerShell
 * script whose bytes do not match. `manifest.json` is excluded from its own
 * listing.
 */
export const RESOURCE_FILES = [
  'nessie-hyperv-bridge.exe',
  'guest\\bzImage',
  'guest\\build-initrd.exe',
  'guest\\init',
  'scripts\\create.ps1',
  'scripts\\remove.ps1',
  'scripts\\start.ps1',
  'scripts\\stop.ps1',
]

/** The two binaries built from this repository's Rust crates. */
export const BUILT_BINARIES = ['nessie-executor-service.exe', 'nessie-executor-tray.exe']

/**
 * Hyper-V sockets address a Linux guest by a `svm_port`, and Windows addresses
 * it by a GUID, so Microsoft defines one template GUID whose first field *is*
 * the port. A service GUID is therefore not free to choose: it is decided by the
 * port the guest listens on, which is `guestControlPort` in
 * `executor/guest/main_linux_arm64.go`.
 *
 * https://learn.microsoft.com/en-us/virtualization/hyper-v-on-windows/user-guide/make-integration-service
 */
export const VSOCK_TEMPLATE_GUID = '00000000-facb-11e6-bd58-64006a7986d3'

/** The guest's control port. Must equal `guestControlPort` in the Go guest. */
export const GUEST_CONTROL_PORT = 49_152

/** The forced-egress tunnel; `GUEST_EGRESS_PORT` in executor/src/firecracker. */
export const GUEST_EGRESS_PORT = 49_153

/**
 * The guest's serial console. Generation 2 machines have no UART until one is
 * added, and `create.ps1` adds COM 1 as a named pipe so a boot that dies before
 * the control hello still leaves evidence.
 */
export const GUEST_CONSOLE_PORT = 49_151

/**
 * Every guest port the host must be able to open a Hyper-V socket to. Each one
 * needs its own registration: the socket is addressed by a GUID, the GUID is
 * decided by the port, and an unregistered GUID simply never opens.
 */
export const HYPERV_SOCKET_PORTS = [GUEST_CONSOLE_PORT, GUEST_CONTROL_PORT, GUEST_EGRESS_PORT]

/** What the registry key is called for a person reading it in regedit. */
export const HYPERV_SOCKET_ELEMENT_NAME = 'Nessie Executor'

export const HYPERV_SOCKET_REGISTRY_KEY =
  'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Virtualization\\GuestCommunicationServices'

/** The built-in Hyper-V Administrators alias, by SID because its name is localized. */
export const HYPERV_ADMINISTRATORS_SID = 'S-1-5-32-578'

export const SERVICE_NAME = 'NessieExecutor'

/** What Apps & features, the Start menu and Services call the product. */
export const PRODUCT_NAME = 'Nessie Computer'

export const SERVICE_DISPLAY_NAME = 'Nessie Computer'

/** The identifier the app's toasts are shown under; the Start menu shortcut carries it. */
export const APP_USER_MODEL_ID = 'com.unlikeotherai.nessie.executor.tray'

/** The link scheme Nessie's web opens this app with. */
export const URL_SCHEME = 'nessie-computer'

/** Kept from before the product was renamed: upgrades find the installed product by it. */
export const UPGRADE_CODE = '9a1c6d2e-4f3b-4a7d-9c1e-2b8f5d6a4e10'

export const SERVICE_ACCOUNT = 'NT SERVICE\\NessieExecutor'

/** The Hyper-V socket service GUID for one guest port. */
export const hyperVSocketServiceGuid = (port) => {
  if (!Number.isInteger(port) || port < 0 || port > 0xffffffff) {
    throw new Error(`${port} is not a Hyper-V socket port.`)
  }
  return `${port.toString(16).padStart(8, '0')}${VSOCK_TEMPLATE_GUID.slice(8)}`
}

/**
 * Windows Installer's ProductVersion is `major.minor.build` with major and minor
 * at most 255 and build at most 65535, and — this is the part that bites — it
 * *ignores* any fourth field when deciding whether an upgrade is newer. A
 * prerelease suffix has no place in it at all, so it is refused here rather than
 * silently dropped into a version two builds would compare as equal.
 */
export const msiVersion = (declared) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(declared).trim())
  if (!match) {
    throw new Error(
      `NESSIE_EXECUTOR_VERSION ${declared} is not a Windows Installer ProductVersion `
      + '(major.minor.build, digits only).',
    )
  }
  const [major, minor, build] = match.slice(1).map(Number)
  if (major > 255 || minor > 255 || build > 65_535) {
    throw new Error(
      `NESSIE_EXECUTOR_VERSION ${declared} exceeds Windows Installer's ProductVersion limits `
      + '(255.255.65535).',
    )
  }
  return `${major}.${minor}.${build}`
}

export const msiFileName = (version) => `NessieExecutor_${msiVersion(version)}_x64.msi`
