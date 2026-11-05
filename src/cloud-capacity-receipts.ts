import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { LocalInferenceTerminationSchema, type LocalInferenceTermination } from '@nessie/executor-protocol'
import { sameChatgptSource, type ChatgptInferenceSource } from './chatgpt-auth-provider.js'
import { cloudCapacityFileDigest } from './cloud-capacity-state.js'

type Receipt = { version: 1; revision: number; termination: LocalInferenceTermination }
type Store = {
  read: (name: string) => Promise<unknown | null>
  replace: (name: string, value: unknown) => Promise<void>
  remove: (name: string) => Promise<void>
  mutate: <T>(fn: () => Promise<T>) => Promise<T>
  barrier: () => Promise<void>
}
export const sameCloudTerminationIdentity = (
  left: LocalInferenceTermination, right: LocalInferenceTermination,
): boolean =>
  isDeepStrictEqual({ ...left, confirmed: false }, { ...right, confirmed: false })

/** A monotonic receipt journal. It never proves provider stop by releasing local capacity. */
export class CloudCapacityReceipts {
  constructor(private readonly directory: string, private readonly source: ChatgptInferenceSource,
    private readonly store: Store) {}

  /** Absence is consumed under the real mutation lock and committed namespace barrier. */
  async hasPendingAttempt(attemptId: string | undefined, readSlot: (name: string) => Promise<unknown | null>,
    validSlot: (value: unknown) => value is { termination: LocalInferenceTermination | null }): Promise<boolean> {
    return this.store.mutate(async () => {
      await this.store.barrier()
      for (let index = 0; index < 16; index++) {
        const slot = await readSlot(`slot-${index}.json`)
        if (slot === null) continue
        if (!validSlot(slot)) throw new Error('Cloud slot cannot prove receipt absence.')
        if (attemptId === undefined || slot.termination === null
          || slot.termination.attemptId === attemptId) return true
      }
      for (const name of await this.names()) {
        const receipt = await this.read(name)
        if (receipt && (attemptId === undefined || receipt.termination.attemptId === attemptId)) return true
      }
      return false
    })
  }

  async count(): Promise<number> { return (await this.names()).length }

  private async names(): Promise<string[]> {
    const names = (await readdir(this.directory)).filter(name => name.startsWith('termination-'))
    if (names.some(name => !/^termination-[a-f0-9-]{36}\.json$/.test(name))) {
      throw new Error('Cloud termination namespace needs repair.')
    }
    if (names.length > 1024) throw new Error('Cloud termination reconciliation needs repair.')
    return names
  }

  private async read(name: string): Promise<Receipt | null> {
    const value = await this.store.read(name) as Receipt | null
    if (value === null) return null
    if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
      || Object.keys(value).length !== 3) throw new Error('Cloud termination receipt needs repair.')
    const termination = LocalInferenceTerminationSchema.parse(value.termination)
    if (termination.inferenceSource?.kind !== 'chatgpt'
      || !sameChatgptSource(this.source, termination.inferenceSource)) {
      throw new Error('Cloud termination receipt source needs repair.')
    }
    return value
  }

  async pending(owner: string): Promise<LocalInferenceTermination | null> {
    return (await this.read(`termination-${owner}.json`))?.termination ?? null
  }

  /** Retry directory/publication durability after an interrupted mutation before slot cleanup. */
  async stabilize(owner: string): Promise<void> {
    const name = `termination-${owner}.json`
    const value = await this.read(name)
    if (!value) throw new Error('Cloud receipt disappeared before ownership cleanup.')
    await this.store.replace(name, value)
  }

  /** Caller holds the pool mutation lock; true is supplied only by an actual terminal proof. */
  async record(owner: string, value: LocalInferenceTermination): Promise<void> {
    const parsed = LocalInferenceTerminationSchema.parse(value)
    if (parsed.inferenceSource?.kind !== 'chatgpt' || !sameChatgptSource(this.source, parsed.inferenceSource)) {
      throw new Error('Cloud receipt publication source does not match its pool.')
    }
    const name = `termination-${owner}.json`
    const existing = await this.read(name)
    if (existing !== null && !sameCloudTerminationIdentity(existing.termination, value)) {
      throw new Error('Cloud termination receipt conflicts with earlier ownership.')
    }
    if (existing === null) {
      if (await this.count() >= 1024) throw new Error('Cloud termination reconciliation is full.')
      await this.store.replace(name, { version: 1, revision: 1, termination: value } satisfies Receipt)
    } else if (!existing.termination.confirmed && value.confirmed) {
      await this.store.replace(name, { ...existing, revision: existing.revision + 1, termination: value })
    }
  }

  async flush(submit: (termination: LocalInferenceTermination) => Promise<void>, reconcileSlots: () => Promise<void>) {
    for (const name of await this.names()) {
      const snapshot = await this.store.mutate(async () => {
        // Includes a receipt published after an earlier global reconciliation.
        // Matching slot cleanup is durable before any ACK can remove this intent.
        await reconcileSlots()
        // Absence may follow an unlink whose directory sync/ack failed. Retry
        // the actual committed-namespace barrier even when no slot remains.
        await this.store.barrier()
        const receipt = await this.read(name)
        return receipt ? { receipt, digest: await cloudCapacityFileDigest(join(this.directory, name)) } : null
      })
      if (!snapshot) continue
      await submit(snapshot.receipt.termination)
      await this.store.mutate(async () => {
        if (await cloudCapacityFileDigest(join(this.directory, name)) === snapshot.digest) await this.store.remove(name)
      })
    }
  }
}
