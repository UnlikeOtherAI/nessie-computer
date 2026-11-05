import { acquirePersonalAdmissionLock } from '../../src/personal-admission-lock.ts'
import { ensureOwnerOnlyStateDirectory } from '../../src/state-security.ts'
import { verifyInferenceTestState } from './local-inference-security.ts'

const security = { platform: 'win32', helper: verifyInferenceTestState }
await ensureOwnerOnlyStateDirectory(process.argv[2], security)
const hold = async () => {
  process.stdout.write('crash-boundary\n')
  await new Promise(() => { setInterval(() => undefined, 1_000) })
}
await acquirePersonalAdmissionLock(process.argv[2], {
  security,
  ...(process.argv[3] === 'before' ? { beforePublish: hold } : { afterPublish: hold }),
})
