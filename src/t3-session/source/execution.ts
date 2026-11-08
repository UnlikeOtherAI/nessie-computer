import { createHash } from 'node:crypto'
import { T3ExecutionResourceReceiptSchema, T3_EXECUTION_SETTINGS_LIMIT,
  type T3ExecutionResourceReceipt, type T3ExecutionProviderResource } from '@nessie/executor-protocol'
import { loadExecutorState } from '../../state-store.js'
import { CaptureFailure, requireCapture } from '../state/sqlite.js'
import { parseT3Homes } from './configuration.js'
import { openNativeT3ExecutionResources } from './native.js'

export interface T3ExecutionResourceScope {
  /** Decode with original ServerSettings in the protected graph callback only.
   * May contain inline credentials; never serialize, log or return these bytes. */
  readonly settingsBytes: Uint8Array
  readonly receipt: T3ExecutionResourceReceipt
  readonly providerReferences: readonly T3ExecutionProviderResource[]
  readonly signal: AbortSignal
  recheck(): Promise<void>
}
const scopes = new WeakMap<T3ExecutionResourceScope, () => Promise<void>>()
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Recognition checks the issued object, never a deserialized receipt or caller
 * callback. The underlying service also rechecks the real graph kernel peer. */
export async function recognizeT3ExecutionResource(scope: T3ExecutionResourceScope): Promise<T3ExecutionResourceReceipt> {
  const recheck = scopes.get(scope)
  requireCapture(recheck, 't3_execution_resource_not_issued')
  await recheck()
  return scope.receipt
}

/** Fixed T3SessionGraph entrypoint only. A path selects local configuration;
 * native graph custody, held source and service-issued handles supply proof.
 * This neither consumes nor extends a retained-import grant. */
export async function withT3ExecutionResources<A>(input: {
  readonly stateDirectory: string
  readonly executorId: string
  readonly admittedRootKey: string
  readonly signal?: AbortSignal
}, use: (scope: T3ExecutionResourceScope) => Promise<A>): Promise<A> {
  requireCapture(process.platform === 'win32' && process.arch === 'x64', 't3_execution_resource_platform_unsupported')
  input.signal?.throwIfAborted()
  const state = await loadExecutorState(input.stateDirectory)
  requireCapture(state.executorId === input.executorId, 't3_execution_resource_executor_changed')
  const homes = parseT3Homes(state.t3SourceHomes ?? [])
  requireCapture(homes.some(home => home.admittedRootKey === input.admittedRootKey), 'source_not_in_manifest')
  const manifest = { revision: String(state.descriptor.revision),
    homes: homes.map(({ admittedRootKey, kind }) => ({ admittedRootKey, kind })) }
  const native = await openNativeT3ExecutionResources({ stateDirectory: input.stateDirectory,
    executorId: input.executorId, admittedRootKey: input.admittedRootKey, manifest })
  const abort = new AbortController()
  let live = true
  let bytes: Buffer | undefined
  let scope: T3ExecutionResourceScope | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    live = false
    abort.abort(new CaptureFailure('t3_execution_resource_closed'))
    if (scope) scopes.delete(scope)
    bytes?.fill(0)
    void native.close()
  }
  const recheck = async () => {
    try {
      input.signal?.throwIfAborted()
      requireCapture(live && !abort.signal.aborted, 't3_execution_resource_closed')
      native.exchange({ op: 'recheck' })
    } catch (error) { stop(); throw error }
  }
  input.signal?.addEventListener('abort', stop, { once: true })
  try {
    await recheck()
    const answer = native.exchange({ op: 'executionDescribe' })
    const parsed = T3ExecutionResourceReceiptSchema.safeParse(answer.receipt)
    requireCapture(parsed.success, 't3_execution_resource_invalid')
    const receipt = freeze(parsed.data)
    requireCapture(receipt.evidence.source.executorId === input.executorId
      && receipt.evidence.source.admittedRootKey === input.admittedRootKey
      && receipt.custody.runtime.pid === process.pid, 't3_execution_resource_mismatch')
    const encoded = answer.settingsBase64
    requireCapture(typeof encoded === 'string' && encoded.length <= Math.ceil(T3_EXECUTION_SETTINGS_LIMIT / 3) * 4
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded),
    't3_execution_settings_invalid')
    bytes = Buffer.from(encoded, 'base64')
    requireCapture(bytes.length === receipt.evidence.settingsLength
      && bytes.toString('base64') === encoded
      && createHash('sha256').update(bytes).digest('hex') === receipt.evidence.settingsDigest,
    't3_execution_settings_invalid')
    const heldBytes = bytes
    scope = Object.freeze({
      get settingsBytes() {
        requireCapture(live && !abort.signal.aborted, 't3_execution_resource_closed')
        return heldBytes
      },
      receipt, providerReferences: receipt.evidence.providerReferences, signal: abort.signal, recheck,
    })
    scopes.set(scope, recheck)
    // Renewal checks actual service/native resources. It does not renew any
    // human consent, inspection challenge or finite command admission.
    timer = setInterval(() => { void recheck().catch(() => { /* stop already invalidated the scope */ }) }, 20_000)
    timer.unref()
    await recheck()
    const result = await use(scope)
    await recheck()
    native.exchange({ op: 'close' })
    return result
  } finally {
    if (timer) clearInterval(timer)
    input.signal?.removeEventListener('abort', stop)
    stop()
    await native.close()
  }
}
