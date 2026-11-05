import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { canonicalExecutorJson, LocalInferenceResultSchema, ExecutorInferenceSourceSchema, sameExecutorInferenceSource,
  type ExecutorInferenceSource, type LocalInferenceResult } from '@nessie/executor-protocol'

const MAX_RECEIPTS = 8
export const PERSONAL_INFERENCE_RECEIPT_CAPACITY = 1024
const MAX_RESULT_BYTES = 512 * 1024
const RECEIPT_TTL_MS = 60 * 60 * 1_000

export type LocalInferenceResultReceipt = {
  attemptId: string
  dispatchFence: number
  result: LocalInferenceResult
}

type StoredReceipt = LocalInferenceResultReceipt & { expiresAt: string }
type PersonalSource = Extract<ExecutorInferenceSource, { kind: 'chatgpt' }>
type StoredReservation = { attemptId: string; dispatchFence: number; expiresAt: string;
  personalReservation: PersonalSource }
type StoredEntry = StoredReceipt | StoredReservation
const entrySource = (entry: StoredEntry) => 'result' in entry ? entry.result.inferenceSource : entry.personalReservation

type EncryptedJournal = {
  ciphertext: string
  iv: string
  tag: string
  version: 1
}

export type LocalInferenceReceiptStorage = {
  read: () => Promise<EncryptedJournal | undefined>
  remove: () => Promise<void>
  write: (value: EncryptedJournal) => Promise<void>
}

export class LocalInferenceReceiptError extends Error {
  override readonly name = 'LocalInferenceReceiptError'

  constructor(readonly code: 'protected_storage_unavailable' | 'receipt_conflict' | 'receipt_limit_exceeded') {
    super(code)
  }
}

const canonicalReceiptResult = (result: LocalInferenceResult): string =>
  canonicalExecutorJson(JSON.parse(JSON.stringify(result)))

const resultSize = (result: LocalInferenceResult): number => Buffer.byteLength(JSON.stringify(result), 'utf8')

const receiptKey = (receipt: Pick<LocalInferenceResultReceipt, 'attemptId' | 'dispatchFence'>): string => (
  `${receipt.attemptId}:${receipt.dispatchFence}`
)

const parseStoredReceipts = (value: unknown): StoredEntry[] => {
  if (!Array.isArray(value) || value.length > MAX_RECEIPTS + PERSONAL_INFERENCE_RECEIPT_CAPACITY) {
    throw new LocalInferenceReceiptError('protected_storage_unavailable')
  }
  return value.map(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new LocalInferenceReceiptError('protected_storage_unavailable')
    }
    const record = candidate as Record<string, unknown>
    const { attemptId, dispatchFence, expiresAt } = record
    if (typeof attemptId !== 'string' || typeof dispatchFence !== 'number' || !Number.isSafeInteger(dispatchFence)
      || dispatchFence < 1 || typeof expiresAt !== 'string' || Number.isNaN(new Date(expiresAt).valueOf())) {
      throw new LocalInferenceReceiptError('protected_storage_unavailable')
    }
    if (record.personalReservation !== undefined) {
      const source = ExecutorInferenceSourceSchema.options[1].safeParse(record.personalReservation)
      if (record.result !== undefined || !source.success) {
        throw new LocalInferenceReceiptError('protected_storage_unavailable')
      }
      return { attemptId, dispatchFence, expiresAt, personalReservation: source.data }
    }
    const result = LocalInferenceResultSchema.safeParse(record.result)
    if (!result.success || resultSize(result.data) > MAX_RESULT_BYTES) {
      throw new LocalInferenceReceiptError('protected_storage_unavailable')
    }
    return { attemptId, dispatchFence, expiresAt, result: result.data }
  })
}

/**
 * Host-owned encrypted receipts: physical cache TTL, personal outcomes retained until exact ACK.
 * The caller must provide a key from a
 * platform protected, non-exportable store and a private persistence adapter;
 * this class intentionally cannot fall back to executor JSON state or memory.
 */
export class EncryptedLocalInferenceReceiptJournal {
  #loaded = false
  #records = new Map<string, StoredEntry>()
  #serial = Promise.resolve()

  constructor(
    private readonly storage: LocalInferenceReceiptStorage,
    private readonly key: Uint8Array,
    private readonly now: () => Date = () => new Date(),
    private readonly options: { personalCapacity?: number } = {},
  ) {
    if (key.byteLength !== 32) throw new Error('Local inference receipt keys must be 32 bytes.')
    if (!Number.isSafeInteger(this.personalCapacity()) || this.personalCapacity() < 1
      || this.personalCapacity() > PERSONAL_INFERENCE_RECEIPT_CAPACITY) throw new Error('Invalid receipt capacity.')
  }

  get(receipt: Pick<LocalInferenceResultReceipt, 'attemptId' | 'dispatchFence'>)
    : Promise<LocalInferenceResultReceipt | undefined> {
    return this.withLock(async () => {
      await this.load()
      await this.sweep()
      const stored = this.#records.get(receiptKey(receipt))
      return stored === undefined || !('result' in stored)
        ? undefined
        : { attemptId: stored.attemptId, dispatchFence: stored.dispatchFence, result: structuredClone(stored.result) }
    })
  }

  pending(): Promise<LocalInferenceResultReceipt[]> {
    return this.withLock(async () => {
      await this.load()
      await this.sweep()
      return [...this.#records.values()].filter((entry): entry is StoredReceipt => 'result' in entry)
        .map(({ attemptId, dispatchFence, result }) => ({
        attemptId, dispatchFence, result: structuredClone(result),
      }))
    })
  }

  private personalCapacity(): number { return this.options.personalCapacity ?? PERSONAL_INFERENCE_RECEIPT_CAPACITY }

  /** Pending outcome ownership is durable before acceptance and counts across concurrent slots. */
  pendingReservations(): Promise<Array<{ attemptId: string; dispatchFence: number; inferenceSource: PersonalSource }>> {
    return this.withLock(async () => {
      await this.load()
      return [...this.#records.values()].filter((entry): entry is StoredReservation => 'personalReservation' in entry)
        .map(entry => ({ attemptId: entry.attemptId, dispatchFence: entry.dispatchFence,
          inferenceSource: structuredClone(entry.personalReservation) }))
    })
  }

  reservePersonalAttempt(input: { attemptId: string; dispatchFence: number; inferenceSource: PersonalSource }) {
    return this.withLock(async () => {
      const source = ExecutorInferenceSourceSchema.options[1].parse(input.inferenceSource)
      await this.load()
      const key = receiptKey(input), existing = this.#records.get(key)
      if (existing) {
        if (!sameExecutorInferenceSource(entrySource(existing), source)) {
          throw new LocalInferenceReceiptError('receipt_conflict')
        }
        return
      }
      const count = [...this.#records.values()].filter(value => entrySource(value)?.kind === 'chatgpt').length
      if (count >= this.personalCapacity()) throw new LocalInferenceReceiptError('receipt_limit_exceeded')
      const records = new Map(this.#records)
      records.set(key, { attemptId: input.attemptId, dispatchFence: input.dispatchFence,
        personalReservation: source, expiresAt: this.now().toISOString() })
      await this.persist(records)
      this.#records = records
    })
  }

  hasPendingAttempt(attemptId: string): Promise<boolean> {
    return this.withLock(async () => { await this.load(); return [...this.#records.values()]
      .some(value => value.attemptId === attemptId) })
  }

  record(receipt: LocalInferenceResultReceipt): Promise<void> {
    return this.withLock(async () => {
      if (!LocalInferenceResultSchema.safeParse(receipt.result).success) {
        throw new LocalInferenceReceiptError('receipt_conflict')
      }
      if (resultSize(receipt.result) > MAX_RESULT_BYTES) {
        throw new LocalInferenceReceiptError('receipt_limit_exceeded')
      }
      await this.load()
      await this.sweep()
      const key = receiptKey(receipt)
      const existing = this.#records.get(key)
      if (existing && 'result' in existing) {
        if (canonicalReceiptResult(existing.result) === canonicalReceiptResult(receipt.result)) return
        throw new LocalInferenceReceiptError('receipt_conflict')
      }
      const personal = receipt.result.inferenceSource?.kind === 'chatgpt'
      if (personal && (!existing
        || !sameExecutorInferenceSource(entrySource(existing), receipt.result.inferenceSource))) {
        throw new LocalInferenceReceiptError('receipt_conflict')
      }
      const count = [...this.#records.values()]
        .filter(value => (entrySource(value)?.kind === 'chatgpt') === personal).length
      if (!existing && count >= (personal ? this.personalCapacity() : MAX_RECEIPTS)) {
        throw new LocalInferenceReceiptError('receipt_limit_exceeded')
      }
      const records = new Map(this.#records)
      records.set(key, {
        ...structuredClone(receipt),
        expiresAt: new Date(this.now().valueOf() + RECEIPT_TTL_MS).toISOString(),
      })
      await this.persist(records)
      this.#records = records
    })
  }

  acknowledge(receipt: LocalInferenceResultReceipt): Promise<boolean> {
    return this.withLock(async () => {
      await this.load()
      const key = receiptKey(receipt), existing = this.#records.get(key)
      if (!existing || !('result' in existing)
        || canonicalReceiptResult(existing.result) !== canonicalReceiptResult(receipt.result)) return false
      const records = new Map(this.#records)
      records.delete(key)
      await this.persist(records)
      this.#records = records
      return true
    })
  }

  private withLock<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#serial.then(task, task)
    this.#serial = next.then(() => undefined, () => undefined)
    return next
  }

  private async load(): Promise<void> {
    if (this.#loaded) return
    let encrypted: EncryptedJournal | undefined
    try {
      encrypted = await this.storage.read()
    } catch {
      throw new LocalInferenceReceiptError('protected_storage_unavailable')
    }
    const records = new Map<string, StoredEntry>()
    if (encrypted !== undefined) {
      if (encrypted.version !== 1) throw new LocalInferenceReceiptError('protected_storage_unavailable')
      let bytes: Buffer
      try {
        const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(encrypted.iv, 'base64url'))
        decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64url'))
        bytes = Buffer.concat([
          decipher.update(Buffer.from(encrypted.ciphertext, 'base64url')),
          decipher.final(),
        ])
      } catch {
        throw new LocalInferenceReceiptError('protected_storage_unavailable')
      }
      try {
        for (const receipt of parseStoredReceipts(JSON.parse(bytes.toString('utf8')) as unknown)) {
          const key = receiptKey(receipt), existing = records.get(key)
          if (existing && JSON.stringify(existing) !== JSON.stringify(receipt)) {
            throw new LocalInferenceReceiptError('protected_storage_unavailable')
          }
          records.set(key, receipt)
        }
      } catch {
        throw new LocalInferenceReceiptError('protected_storage_unavailable')
      }
    }
    const personalCount = [...records.values()].filter(row => entrySource(row)?.kind === 'chatgpt').length
    if (personalCount > PERSONAL_INFERENCE_RECEIPT_CAPACITY || records.size - personalCount > MAX_RECEIPTS) {
      throw new LocalInferenceReceiptError('protected_storage_unavailable')
    }
    this.#records = records
    this.#loaded = true
  }

  private async sweep(): Promise<void> {
    const now = this.now().valueOf()
    let changed = false
    const records = new Map(this.#records)
    for (const [key, receipt] of records) {
      if (entrySource(receipt)?.kind === 'chatgpt') continue
      if (new Date(receipt.expiresAt).valueOf() <= now) {
        records.delete(key)
        changed = true
      }
    }
    if (changed) { await this.persist(records); this.#records = records }
  }

  private async persist(records: Map<string, StoredEntry>): Promise<void> {
    if (records.size === 0) {
      try {
        await this.storage.remove()
        return
      } catch {
        this.#loaded = false
        throw new LocalInferenceReceiptError('protected_storage_unavailable')
      }
    }
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const plaintext = Buffer.from(JSON.stringify([...records.values()]))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    try {
      await this.storage.write({
        ciphertext: ciphertext.toString('base64url'),
        iv: iv.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        version: 1,
      })
    } catch {
      this.#loaded = false
      throw new LocalInferenceReceiptError('protected_storage_unavailable')
    }
  }
}
