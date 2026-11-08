import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { release } from 'node:os'
import { arch, platform } from 'node:process'

import {
  EXECUTOR_MINIMUM_OS_MAJOR_VERSIONS,
  ExecutorPlatformSchema,
  ExecutorSupervisorSchema,
  type ExecutorPlatform,
  type ExecutorSandboxBackend,
  type ExecutorSupervisor,
} from '@nessie/executor-protocol'

/**
 * Every host fact the descriptor states, read through one injectable probe so
 * the decisions below are testable on any machine. Nothing here reads a
 * capability from a version string: KVM and Hyper-V are decided by asking the
 * operating system for the exact resource the sandbox backend needs.
 */
export type HostPlatformProbe = {
  architecture: string
  /** True when the current user may both read and write the path. */
  canReadWrite: (path: string) => boolean
  environment: Record<string, string | undefined>
  exists: (path: string) => boolean
  kernelRelease: string
  /**
   * macOS's own product version ("15.6", "27.0"), when the host states one.
   * Absent on every other platform, and on a macOS whose system version file
   * cannot be read.
   */
  macosProductVersion?: string
  platform: string
}

export type ExecutorHost = {
  platform: ExecutorPlatform
  sandboxBackend: ExecutorSandboxBackend
  supervisor: ExecutorSupervisor
}

export const LINUX_KVM_DEVICE = '/dev/kvm'
/** The Hyper-V Virtual Machine Management service binary. */
export const WINDOWS_HYPERV_SERVICE_BINARY = 'System32\\vmms.exe'
export const SUPERVISOR_ENVIRONMENT_VARIABLE = 'NESSIE_EXECUTOR_SUPERVISOR'

const UNSUPPORTED_HOST =
  'This Nessie Computer release supports macOS 15+ on Apple Silicon, Linux on x86_64 or arm64, '
  + 'and Windows 10 22H2+ on x86_64. Set no execution capability on other platforms.'

/** macOS states its own version here, in XML, on every supported release. */
export const MACOS_SYSTEM_VERSION_PATH = '/System/Library/CoreServices/SystemVersion.plist'

/**
 * The product version macOS publishes about itself, or `undefined` when the
 * file is missing or does not state one. The match is deliberately narrow —
 * one key, one string — because this is a version probe, not a plist parser.
 */
export const readMacosProductVersion = (
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string | undefined => {
  let contents: string
  try {
    contents = read(MACOS_SYSTEM_VERSION_PATH)
  } catch {
    return undefined
  }
  const match = /<key>ProductVersion<\/key>\s*<string>([0-9][0-9.]*)<\/string>/.exec(contents)
  return match?.[1]
}

export const defaultHostPlatformProbe = (): HostPlatformProbe => ({
  architecture: arch,
  canReadWrite: (path) => {
    try {
      accessSync(path, constants.R_OK | constants.W_OK)
      return true
    } catch {
      return false
    }
  },
  environment: process.env,
  exists: (path) => {
    try {
      statSync(path)
      return true
    } catch {
      return false
    }
  },
  // `os.release()` is the operating system's own version string on all three
  // platforms: Darwin's kernel version, the Linux kernel release, and the
  // Windows "10.0.<build>" triple.
  kernelRelease: release(),
  ...(platform === 'darwin'
    ? { macosProductVersion: readMacosProductVersion() }
    : {}),
  platform,
})

const majorVersion = (value: string, index: number): number => {
  const parsed = Number.parseInt(value.split('.')[index] ?? '', 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${UNSUPPORTED_HOST} The host reported an unreadable version "${value}".`)
  }
  return parsed
}

const assertMinimumVersion = (candidate: ExecutorPlatform): ExecutorPlatform => {
  const parsed = ExecutorPlatformSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new Error(
      `${UNSUPPORTED_HOST} This host reports ${candidate.os} ${candidate.osMajorVersion} `
      + `on ${candidate.architecture}, below the minimum of `
      + `${EXECUTOR_MINIMUM_OS_MAJOR_VERSIONS[candidate.os]}.`,
    )
  }
  return parsed.data
}

/**
 * macOS is asked for its own version rather than having one derived from its
 * kernel. Deriving worked while Darwin 24 meant macOS 15, and then stopped:
 * Apple renumbered at macOS 26, so a fixed offset now names a release that
 * does not exist — this host reports Darwin 27 and macOS 27, which the old
 * arithmetic called macOS 18. The descriptor a person reviews states this
 * version, so a plausible wrong answer is worse than an unreadable one.
 *
 * The kernel derivation survives only as the fallback for a host whose system
 * version file cannot be read, where an approximate major version is still
 * better than refusing to run at all.
 *
 * Virtualization.framework's guest contract is Apple Silicon only, so an Intel
 * Mac is refused rather than silently degraded.
 */
const macosHost = (probe: HostPlatformProbe): ExecutorHost => {
  if (probe.architecture !== 'arm64') throw new Error(UNSUPPORTED_HOST)
  return {
    platform: assertMinimumVersion({
      architecture: 'arm64',
      os: 'macos',
      osMajorVersion: probe.macosProductVersion === undefined
        ? majorVersion(probe.kernelRelease, 0) - 9
        : majorVersion(probe.macosProductVersion, 0),
    }),
    sandboxBackend: 'virtualization_framework',
    supervisor: hostSupervisor(probe),
  }
}

const linuxHost = (probe: HostPlatformProbe): ExecutorHost => {
  if (probe.architecture !== 'arm64' && probe.architecture !== 'x64') {
    throw new Error(UNSUPPORTED_HOST)
  }
  return {
    platform: assertMinimumVersion({
      architecture: probe.architecture,
      os: 'linux',
      osMajorVersion: majorVersion(probe.kernelRelease, 0),
    }),
    // Firecracker needs read/write access to the KVM device as the daemon's own
    // user; group membership alone is not the question, the open is.
    sandboxBackend: probe.canReadWrite(LINUX_KVM_DEVICE) ? 'firecracker' : 'none',
    supervisor: hostSupervisor(probe),
  }
}

/**
 * Windows publishes its build number as the third segment of the kernel
 * release ("10.0.22631"), and that build number — not the marketing name — is
 * the version every support statement is written against.
 */
const windowsHost = (probe: HostPlatformProbe): ExecutorHost => {
  if (probe.architecture !== 'x64') throw new Error(UNSUPPORTED_HOST)
  const systemRoot = probe.environment.SystemRoot || 'C:\\Windows'
  return {
    platform: assertMinimumVersion({
      architecture: 'x64',
      os: 'windows',
      osMajorVersion: majorVersion(probe.kernelRelease, 2),
    }),
    // The management service binary is present exactly when the Hyper-V
    // platform feature is installed; an edition without it never has the file.
    sandboxBackend: probe.exists(`${systemRoot}\\${WINDOWS_HYPERV_SERVICE_BINARY}`)
      ? 'hyperv'
      : 'none',
    supervisor: hostSupervisor(probe),
  }
}

/**
 * The supervisor is a deployment fact, not a guess: the desktop shell sets it
 * when it launches the packaged companion, and the standalone package leaves it
 * unset. An unrecognised value is refused instead of falling back, because a
 * person reading "Nessie Executor service on Linux" must be reading the truth.
 */
export const hostSupervisor = (probe: HostPlatformProbe): ExecutorSupervisor => {
  const configured = probe.environment[SUPERVISOR_ENVIRONMENT_VARIABLE]
  if (configured === undefined) return 'service'
  const parsed = ExecutorSupervisorSchema.safeParse(configured)
  if (!parsed.success) {
    throw new Error(
      `Set ${SUPERVISOR_ENVIRONMENT_VARIABLE} to "desktop" or "service", or leave it unset.`,
    )
  }
  return parsed.data
}

export const detectExecutorHost = (
  probe: HostPlatformProbe = defaultHostPlatformProbe(),
): ExecutorHost => {
  if (probe.platform === 'darwin') return macosHost(probe)
  if (probe.platform === 'linux') return linuxHost(probe)
  if (probe.platform === 'win32') return windowsHost(probe)
  throw new Error(UNSUPPORTED_HOST)
}

/**
 * The remedy a person can act on, per host. A sandbox backend of `none` is not
 * a defect to hide: the executor still pairs and serves the copy-on-write
 * workspace bundle, and this names what would unlock the rest.
 */
export const sandboxRemedyForHost = (host: ExecutorHost): string => {
  if (host.platform.os === 'linux') {
    return 'Sandboxed commands, browsers, and coding sessions need /dev/kvm: '
      + 'add your user to the `kvm` group and sign in again.'
  }
  if (host.platform.os === 'windows') {
    return 'Sandboxed commands, browsers, and coding sessions need Hyper-V: '
      + 'enable it on Windows Pro, Enterprise, or Education and restart.'
  }
  return 'This host reports no sandbox backend, so only workspace operations can be offered.'
}
