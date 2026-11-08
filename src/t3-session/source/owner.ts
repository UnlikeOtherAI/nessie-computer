import * as Schema from 'effect/Schema'
import { SourceContracts } from '@nessie/t3-session-source/engine'
import { loadExecutorState } from '../../state-store.js'
import type { AdmittedT3SourcePort, ProvenT3Source, T3SourceManifest } from '../import/manifest.js'
import { checkT3SourceLayout } from '../import/snapshot.js'
import { tablesForLayout } from '../import/layout.js'
import { requireCapture } from '../state/sqlite.js'
import { parseT3Homes } from './configuration.js'
import { heldSourceDatabase } from './database.js'
import { openNativeT3Source } from './native.js'

export interface LivePhysicalT3Binding {
  readonly source: ProvenT3Source
  readonly executorId: string
  readonly databaseIdentity: string
  readonly environmentIdentity: string
  readonly legacyCopyProvenance: 'not_attested_by_original_source'
}
export interface MachineT3SourceOwner extends AdmittedT3SourcePort {
  manifest(): Promise<T3SourceManifest>
  /** Canonical historical-human admission must use this exact daemon owner.
   * Returns only a currently live, issued binding, never a historical human. */
  recognize(recheck: () => Promise<void>): Promise<LivePhysicalT3Binding>
}

const owners = new Map<string, MachineT3SourceOwner>()

/** Existing daemon resource registration owns creation and teardown. Merely
 * knowing a root path, environment ID or serialized descriptor cannot mint it. */
export function registerMachineT3Sources(stateDirectory: string, executorId: string): () => void {
  requireCapture(!owners.has(executorId), 't3_source_owner_already_registered')
  const leases = new Map<() => Promise<void>, {
    binding: LivePhysicalT3Binding; close: () => void; recheckNow: () => void
  }>()
  let active = true
  const manifest = async (): Promise<T3SourceManifest> => {
    requireCapture(active, 't3_source_owner_closed')
    const state = await loadExecutorState(stateDirectory)
    requireCapture(active && state.executorId === executorId, 't3_source_owner_changed')
    const homes = parseT3Homes(state.t3SourceHomes ?? [])
    return Object.freeze({ revision: String(state.descriptor.revision),
      homes: Object.freeze(homes.map(({ admittedRootKey, kind }) => Object.freeze({ admittedRootKey, kind }))) })
  }
  const owner: MachineT3SourceOwner = Object.freeze({
    manifest,
    async recognize(recheck: () => Promise<void>) {
      requireCapture(active && leases.has(recheck), 't3_source_lease_not_issued_here')
      const lease = leases.get(recheck)
      requireCapture(active && lease, 't3_source_lease_not_issued_here')
      lease.recheckNow()
      return lease.binding
    },
    async withReadonlySource(requested, admittedRootKey, use) {
      requireCapture(JSON.stringify(requested) === JSON.stringify(await manifest()), 't3_source_manifest_stale_or_incomplete')
      requireCapture(requested.homes.some(home => home.admittedRootKey === admittedRootKey), 'source_not_in_manifest')
      const native = await openNativeT3Source({ stateDirectory, executorId, manifest: requested, admittedRootKey })
      let live = true
      const recheck = async () => {
        requireCapture(active && live && leases.has(recheck), 't3_source_lease_closed')
        native.exchange({ op: 'recheck' })
      }
      try {
        requireCapture(active, 't3_source_owner_closed')
        const description = native.exchange({ op: 'describe' })
        const raw = description.source as ProvenT3Source
        requireCapture(raw && raw.admittedRootKey === admittedRootKey
          && typeof raw.physicalRootKey === 'string' && /^windows-file-id:[a-f0-9]{64}$/u.test(raw.physicalRootKey)
          && (raw.layout === 'v2-80' || raw.layout === 'legacy-54')
          && raw.databaseRole === (raw.layout === 'v2-80' ? 'authoritative-v2' : 'sole-legacy')
          && description.executorId === executorId && typeof description.databaseIdentity === 'string'
          && typeof description.environmentIdentity === 'string'
          && description.legacyCopyProvenance === 'not_attested_by_original_source', 't3_source_native_protocol_invalid')
        const source = Object.freeze({ ...raw,
          environmentId: Schema.decodeUnknownSync(SourceContracts.EnvironmentId)(raw.environmentId) })
        const binding: LivePhysicalT3Binding = Object.freeze({ source, executorId,
          databaseIdentity: description.databaseIdentity, environmentIdentity: description.environmentIdentity,
          legacyCopyProvenance: 'not_attested_by_original_source' })
        leases.set(recheck, { binding, close: native.close,
          recheckNow: () => { native.exchange({ op: 'recheck' }) } })
        const database = heldSourceDatabase(native.exchange, source.layout)
        database.exec('BEGIN')
        try {
          checkT3SourceLayout(database, source, tablesForLayout(source.layout))
          database.exec('COMMIT')
        } catch (error) {
          try { database.exec('ROLLBACK') } catch { /* The native lease closes below. */ }
          throw error
        }
        await recheck()
        const result = await use(source, database, recheck)
        requireCapture(active && live && leases.has(recheck), 't3_source_lease_closed')
        native.exchange({ op: 'recheck' })
        return result
      } finally {
        live = false
        leases.delete(recheck)
        native.close()
      }
    },
  })
  owners.set(executorId, owner)
  return () => {
    active = false
    for (const lease of leases.values()) lease.close()
    leases.clear()
    if (owners.get(executorId) === owner) owners.delete(executorId)
  }
}

/** Machine-only doorway for the next backend/canonical-owner integration. */
export function machineT3Sources(executorId: string): MachineT3SourceOwner {
  const owner = owners.get(executorId)
  requireCapture(owner, 't3_source_machine_owner_not_running')
  return owner
}
