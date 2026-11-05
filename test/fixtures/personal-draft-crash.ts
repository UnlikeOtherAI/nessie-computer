import { open } from 'node:fs/promises'
import { acquirePersonalAdmissionLock } from '../../src/personal-admission-lock.js'
const [, , lockDirectory, draft] = process.argv
if (!lockDirectory || !draft) throw new Error('Fixture paths required')
await acquirePersonalAdmissionLock(lockDirectory)
const file = await open(draft, 'wx', 0o600)
await file.writeFile('revoked-fixture-bytes')
await file.sync()
await file.close()
process.stdout.write('READY\n')
setInterval(() => undefined, 1_000)
