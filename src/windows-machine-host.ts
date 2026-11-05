import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename } from 'node:path'
import { z } from 'zod'
import { acquireNativeControlLease, nativeControlEnvironment } from './native-control-lease.js'
import { packagedNativeHelperPath } from './state-security.js'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'

const failure = () => new PersonalInferenceProtectionError('personal_inference_service_barrier_unavailable')
const active = () => process.platform === 'win32' && process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1'
  && basename(process.execPath).toLowerCase() === 'nessie-executor-runtime.exe'
const execute = promisify(execFile)

export const assertWindowsMachineHostAllowed = async (): Promise<void> => {
  if (!active()) return
  try {
    const response = await execute(packagedNativeHelperPath(), ['managed-host-check'], {
      env: nativeControlEnvironment(), windowsHide: true, timeout: 5000, maxBuffer: 4096,
    })
    z.object({ status: z.literal('verified'), protocolVersion: z.literal(1), guardVersion: z.literal(2),
      allowed: z.literal(true) }).strict().parse(JSON.parse(response.stdout))
  } catch { throw failure() }
}

export const acquireWindowsMachineHostLease = async () => {
  if (!active()) return null
  const nonce = randomBytes(32).toString('hex')
  const held = await acquireNativeControlLease({ helper: packagedNativeHelperPath(), command: 'managed-host-barrier',
    nonce, maximumBytes: 4096,
    parse: value => {
      const frame = z.object({ status: z.literal('verified'), protocolVersion: z.literal(1),
        nonce: z.literal(nonce) }).strict().parse(value)
      return frame
    },
  })
  held.assertLive()
  return { release: async () => {
    // Failure keeps the durable service host lease. Killing its pipe or local
    // registration cannot prove an arbitrary process tree has stopped.
    try { await held.release() } finally { await held.abort() }
  } }
}
