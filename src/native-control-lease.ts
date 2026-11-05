import { spawn } from 'node:child_process'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'

const failure = () => new PersonalInferenceProtectionError('personal_inference_native_control_unknown')
export const nativeControlEnvironment = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !key.startsWith('NODE_') && !key.startsWith('LD_') && !key.startsWith('DYLD_')
    && !key.startsWith('NESSIE_TEST_') && !key.startsWith('NESSIE_EXECUTOR_NATIVE_') && !key.startsWith('NESSIE_MANAGED_')
    && !['GCONV_PATH', 'LOCPATH', 'GLIBC_TUNABLES', 'OPENSSL_CONF', 'OPENSSL_MODULES'].includes(key)))

/** A public ACK borrows a live native hold. EOF/transport abort is never custody clearance. */
export const acquireNativeControlLease = async <T>(input: {
  helper: string; command: string; nonce: string; parse: (value: unknown) => T; maximumBytes?: number
}) => {
  const child = spawn(input.helper, [input.command, input.nonce], {
    env: nativeControlEnvironment(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  })
  let closed = false, succeeded = false
  const stopped = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve() }))
  const wait = async () => {
    if (closed) return
    let timer: NodeJS.Timeout | undefined
    try { await Promise.race([stopped, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(failure()), 3000)
    })]) } finally { clearTimeout(timer) }
  }
  const abort = async () => {
    child.stdin.destroy()
    if (!closed) child.kill('SIGKILL')
    try { await wait() } catch (error) {
      child.stdout.destroy(); child.unref(); throw error
    }
  }
  const value = await new Promise<T>((resolve, reject) => {
    let output = Buffer.alloc(0), answered = false
    const timer = setTimeout(() => fail(), 15000)
    const fail = () => { clearTimeout(timer); reject(failure()) }
    child.once('error', fail); child.once('close', () => { if (!answered) fail() }); child.stdin.once('error', fail)
    child.stdout.on('data', (chunk: Buffer) => {
      if (answered) return
      output = Buffer.concat([output, chunk])
      if (output.length > (input.maximumBytes ?? 512 * 1024)) { fail(); return }
      const newline = output.indexOf(10)
      if (newline < 0) return
      try {
        const parsed = input.parse(JSON.parse(output.subarray(0, newline).toString('utf8')))
        clearTimeout(timer); answered = true; resolve(parsed)
      } catch { fail() }
    })
  }).catch(async (error: unknown) => { await abort(); throw error })
  return { value,
    assertLive: () => { if (closed) throw failure() },
    release: async () => {
      if (succeeded) return
      if (closed) throw failure()
      child.stdin.end('release\n'); await wait()
      if (child.exitCode !== 0) throw failure()
      succeeded = true
    },
    abort,
  }
}
