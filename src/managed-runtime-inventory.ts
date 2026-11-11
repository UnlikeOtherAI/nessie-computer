import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { PERSONAL_INFERENCE_GUARD_VERSION } from '@nessie/executor-protocol'
import { createAdmissionProcessInspector } from './personal-admission-lock.js'
import { PersonalInferenceProtectionError, personalInferenceDirectory } from './personal-inference-paths.js'
import { collectExecutorRuntimeFacts, packagedRuntimeDirectory, verifyExecutorRuntime } from './runtime-integrity.js'
import { acquireNativeControlLease } from './native-control-lease.js'

const RecordSchema = z.object({
  protocolVersion: z.literal(1), guardVersion: z.literal(PERSONAL_INFERENCE_GUARD_VERSION),
  bootId: z.string().uuid(), supervisorPid: z.number().int().positive(),
  supervisorStartedAt: z.string().regex(/^\d+$/u),
  childPid: z.number().int().positive(), childStartedAt: z.string().regex(/^\d+$/u),
  releaseDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  activity: z.enum(['serve', 'serve-direct-local-inference', 'personal-chatgpt-credential']).optional(),
}).strict()
const InventorySchema = z.object({
  status: z.literal('verified'), protocolVersion: z.literal(1), nonce: z.string().regex(/^[a-f0-9]{64}$/u),
  root: z.string(), guardVersion: z.literal(PERSONAL_INFERENCE_GUARD_VERSION),
  releaseDigest: z.string().regex(/^[a-f0-9]{64}$/u), records: z.array(RecordSchema).max(256),
  machineEpoch: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  retiredHostControllers: z.array(z.object({
    pid: z.number().int().positive(), startedAt: z.string().regex(/^\d+$/u), bootId: z.string().uuid(),
    journal: RecordSchema.optional(),
  }).strict()).max(4096).optional(),
}).strict()

export type RetiredHostController = NonNullable<z.infer<typeof InventorySchema>['retiredHostControllers']>[number]
export type ManagedRuntimeInventory = Readonly<z.infer<typeof InventorySchema>>
const rejected = (): PersonalInferenceProtectionError =>
  new PersonalInferenceProtectionError('personal_inference_managed_inventory_unverified')

/**
 * Actual native creation/probe evidence under retained kernel launch
 * barriers. A durable public transition claim fences later launches if this
 * helper exits before release. Windows additionally requires the signed service
 * epoch. None of these holds claims credential-inaccessible host isolation.
 */
export const withManagedRuntimeInventory = async <T>(
  work: (inventory: ManagedRuntimeInventory) => Promise<T>,
): Promise<T> => {
  if (!['linux', 'darwin', 'win32'].includes(process.platform)
    || process.env.NESSIE_EXECUTOR_PACKAGED_CLI !== '1') throw rejected()
  const directory = packagedRuntimeDirectory()
  const helperName = process.platform === 'win32' ? 'nessie-executor-native.exe' : 'nessie-executor-native'
  const facts = await collectExecutorRuntimeFacts(directory, { runningBundlePath: process.argv[1] ?? '' })
  if (!verifyExecutorRuntime(facts).ok || facts.digests[helperName] === undefined) throw rejected()
  const own = await createAdmissionProcessInspector().identify(process.pid)
  if (!own?.startedAt) throw rejected()
  const nonce = randomBytes(32).toString('hex')
  const held = await acquireNativeControlLease({ helper: join(directory, helperName),
    command: 'managed-inventory-barrier', nonce,
    parse: value => {
      const parsed = InventorySchema.parse(value)
      const ownRecord = parsed.records.find(record => record.childPid === process.pid
        && record.childStartedAt === own.startedAt)
      if (parsed.nonce !== nonce || parsed.root !== personalInferenceDirectory() || !ownRecord
        || (process.platform === 'win32') !== (parsed.machineEpoch !== undefined)
        || parsed.retiredHostControllers !== undefined && process.platform !== 'darwin'
        || parsed.retiredHostControllers?.some(record => record.bootId !== ownRecord.bootId
          || record.journal && (record.journal.bootId !== record.bootId || record.journal.childPid !== record.pid
            || record.journal.childStartedAt !== record.startedAt)
          || parsed.records.some(live => live.childPid === record.pid && live.childStartedAt === record.startedAt))
        || parsed.records.some(record => record.releaseDigest !== parsed.releaseDigest)
        || new Set(parsed.records.map(record => record.childPid)).size !== parsed.records.length) throw rejected()
      return parsed
    },
  })
  try {
    held.assertLive()
    const result = await work(held.value)
    held.assertLive()
    await held.release()
    return result
  } finally { await held.abort() }
}
