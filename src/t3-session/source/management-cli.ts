import { RetainedIssuerOfferSchema, RetainedIssuerPossessionProofSchema,
  RetainedIssuerPendingSchema } from '@nessie/executor-protocol'
import { defaultPairingDirectory } from '../../pairing-code-directory.js'
import { loadExecutorState } from '../../state-store.js'
import { retainedImportPost } from '../ownership/import-transport.js'
import { requireCapture } from '../state/sqlite.js'
import { parseT3Homes } from './configuration.js'

/** Public proposals/queued requests only. This CLI cannot approve, consume or
 * commit an import and never reads a native private issuer key. */
export async function runRetainedManagementCli(args: string[]): Promise<boolean> {
  if (args[0] !== 't3-retained') return false
  requireCapture(args.length === 3 && args[1] === '--executor'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(args[2]!),
  'retained_import_management_usage')
  const directory = await defaultPairingDirectory(args[2])
  const state = await loadExecutorState(directory)
  requireCapture(state.executorId === args[2], 'retained_import_executor_mismatch')
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    length += bytes.length
    requireCapture(length <= 65_536, 'retained_import_management_input_too_large')
    chunks.push(bytes)
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  requireCapture(input && typeof input === 'object' && !Array.isArray(input), 'retained_import_management_usage')
  let output: unknown
  switch (input.operation) {
    case 'roots':
      requireCapture(Object.keys(input).length === 1, 'retained_import_management_usage')
      output = parseT3Homes(state.t3SourceHomes ?? []).map(({ admittedRootKey, kind }) => ({ admittedRootKey, kind }))
      break
    case 'issuer.pending':
      requireCapture(Object.keys(input).length === 1, 'retained_import_management_usage')
      output = RetainedIssuerPendingSchema.parse(await retainedImportPost(directory, { operation: 'issuer.pending' }))
      break
    case 'issuer.offer': {
      requireCapture(Object.keys(input).length === 2, 'retained_import_management_usage')
      const offer = RetainedIssuerOfferSchema.parse(input.offer)
      requireCapture(offer.executorId === state.executorId, 'retained_import_executor_mismatch')
      output = await retainedImportPost(directory, { operation: 'issuer.offer', offer })
      break
    }
    case 'issuer.proof': {
      requireCapture(Object.keys(input).length === 2, 'retained_import_management_usage')
      const proof = RetainedIssuerPossessionProofSchema.parse(input.proof)
      output = await retainedImportPost(directory, { operation: 'issuer.proof', proof })
      break
    }
    default: throw new Error('retained_import_management_operation_unsupported')
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)
  return true
}
