import { spawn } from 'node:child_process'
import {
  ExecutorLocalUpdateRequestSchema, ExecutorLocalUpdateStatusSchema, ExecutorSoftwareUpdateRequestSchema,
  type ExecutorLocalUpdateRequest, type ExecutorLocalUpdateStatus, type ExecutorSoftwareStatus,
  type ExecutorSoftwareUpdateRequest,
} from '@nessie/executor-protocol'
import { packagedNativeHelperPath } from '../state-security.js'
import { executorSoftwareRevision, executorSoftwareVersion } from './version.js'

/** A source checkout reports its real version without pretending to be an installed updater. */
export const uninstalledSoftwareStatus = (): ExecutorSoftwareStatus => ({
  format: 1, installedVersion: executorSoftwareVersion(),
  ...(executorSoftwareRevision() ? { sourceCommit: executorSoftwareRevision() } : {}),
  automatic: true, channel: 'stable', phase: 'unsupported', canInstall: false,
})

type NativeRequest = ExecutorLocalUpdateRequest | {
  operation: 'request'; request: ExecutorSoftwareUpdateRequest
}

type UpdateClientOptions = { background?: boolean }

const nativeUpdate = async (
  request: NativeRequest, options: UpdateClientOptions = {},
): Promise<ExecutorLocalUpdateStatus> => {
  if (process.env.NESSIE_EXECUTOR_PACKAGED_CLI !== '1') {
    if (request.operation === 'status' || request.operation === 'check') {
      return { ...uninstalledSoftwareStatus(), notify: false }
    }
    throw new Error('update.installed_updater_required')
  }
  return new Promise((settle, fail) => {
    // This child is unprivileged. Only its authenticated native IPC peer may
    // select a release or replace the installed payload.
    const child = spawn(packagedNativeHelperPath(), ['update-control'], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES'].includes(key))),
    })
    let output = ''
    let finished = false
    const refuse = () => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      child.kill()
      fail(new Error('update.coordinator_unavailable'))
    }
    const timeout = setTimeout(refuse, request.operation === 'status' ? 100_000 : 10_000)
    child.once('error', refuse)
    child.stdin.on('error', refuse)
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.length > 16_384) refuse()
    })
    child.once('close', (code) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      try {
        if (code !== 0) throw new Error('update.coordinator_unavailable')
        settle(ExecutorLocalUpdateStatusSchema.parse(JSON.parse(output)))
      } catch { fail(new Error('update.coordinator_unavailable')) }
    })
    child.stdin.end(`${JSON.stringify(request)}\n`)
    if (options.background) {
      // A launch check may finish while an ordinary command runs, but must not
      // keep that command alive or wait for a missing native coordinator.
      child.unref()
      timeout.unref()
      for (const stream of [child.stdin, child.stdout]) {
        (stream as typeof stream & { unref?: () => void }).unref?.()
      }
    }
  })
}

export const localUpdate = (
  request: ExecutorLocalUpdateRequest, options?: UpdateClientOptions,
): Promise<ExecutorLocalUpdateStatus> =>
  nativeUpdate(ExecutorLocalUpdateRequestSchema.parse(request), options)

export const requestSoftwareUpdate = (request: ExecutorSoftwareUpdateRequest): Promise<ExecutorLocalUpdateStatus> =>
  nativeUpdate({ operation: 'request', request: ExecutorSoftwareUpdateRequestSchema.parse(request) })

/** Failure of the updater must never become failure of a healthy executor heartbeat. */
export const reportedSoftwareStatus = async (): Promise<ExecutorSoftwareStatus> => {
  try {
    const { notify: _notify, sourceCommit: _revision, ...software } = await localUpdate({ operation: 'status' })
    return { ...software, installedVersion: executorSoftwareVersion(),
      ...(executorSoftwareRevision() ? { sourceCommit: executorSoftwareRevision() } : {}) }
  } catch {
    return { ...uninstalledSoftwareStatus(), code: 'update.coordinator_unavailable' }
  }
}

/** A slow local signature check must not delay reconnecting to the team.
 * Carry one pending read across heartbeats and consume its result once. */
export const heartbeatSoftwareReader = (read = reportedSoftwareStatus, waitMs = 250) => {
  let pending: Promise<ExecutorSoftwareStatus> | undefined
  let completedAt = 0
  return async (): Promise<ExecutorSoftwareStatus | undefined> => {
    if (completedAt && Date.now() - completedAt > 30_000) pending = undefined
    if (!pending) {
      completedAt = 0
      pending = read().then((status) => { completedAt = Date.now(); return status })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const status = await Promise.race([pending, new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), waitMs)
      })])
      if (status) pending = undefined
      return status
    } catch {
      pending = undefined
      return undefined
    } finally { clearTimeout(timer) }
  }
}
