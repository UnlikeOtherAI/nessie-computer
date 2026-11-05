import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'
import { packagedNativeHelperPath } from './state-security.js'

const execute = promisify(execFile)
const Context = z.object({ version: z.literal(1), pid: z.number().int().positive(),
  bootId: z.string().uuid(), startedAt: z.string().regex(/^[1-9][0-9]*$/u) }).strict()

/** The compiled native helper reads microsecond/FILETIME generations from the kernel. */
export const nativeKernelProcessGeneration = async (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid < 1 || process.env.NESSIE_EXECUTOR_PACKAGED_CLI !== '1') {
    throw new PersonalInferenceProtectionError('personal_inference_runtime_unverified')
  }
  const result = await execute(packagedNativeHelperPath(), ['kernel-process-context', String(pid)], {
    timeout: 5000, maxBuffer: 4096, windowsHide: true,
    env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
      : { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  })
  const context = Context.parse(JSON.parse(result.stdout))
  if (context.pid !== pid) throw new PersonalInferenceProtectionError('personal_inference_runtime_unverified')
  return context
}

/** A PID/start pair alone is not a reboot identity. Never derive a boot from wall time. */
export const currentKernelBootId = async (): Promise<string | undefined> => {
  if (process.platform === 'win32' && process.env.NESSIE_EXECUTOR_PACKAGED_CLI !== '1') return undefined
  let bootId: string
  try {
    if (process.platform === 'linux') bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    else if (process.platform === 'darwin') {
      const result = await execute('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
        timeout: 5000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      })
      bootId = result.stdout.trim().toLowerCase()
    } else if (process.platform === 'win32') {
      const result = await execute(packagedNativeHelperPath(), ['kernel-process-context', String(process.pid)], {
        timeout: 5000, maxBuffer: 4096, windowsHide: true,
        env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
      })
      const context = Context.parse(JSON.parse(result.stdout))
      if (context.pid !== process.pid) throw new Error('kernel_context_mismatch')
      bootId = context.bootId
    } else return undefined
  } catch {
    throw new PersonalInferenceProtectionError('personal_inference_runtime_unverified')
  }
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(bootId)
    || bootId === '00000000-0000-0000-0000-000000000000') {
    throw new PersonalInferenceProtectionError('personal_inference_runtime_unverified')
  }
  return bootId
}
