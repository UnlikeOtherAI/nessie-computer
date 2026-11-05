import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { lstat, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireOwnerStateLock, createAdmissionProcessInspector,
  type AdmissionProcessInspector } from './personal-admission-lock.js'
import { replaceOwnerOnlyJson } from './owner-only-json.js'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'
import { assertOwnerOnlyStatePath, ensureOwnerOnlyStateDirectory, type StateSecurityDeps } from './state-security.js'

type Claim = { version: 1; pid: number; startedAt: string; token: string }
const fail = (): never => { throw new PersonalInferenceProtectionError('personal_state_writer_unknown') }

/** A timed-out writer is durable shared state until its exact child generation is proven gone. */
export class PersonalNativeWriters {
  private readonly directory: string
  constructor(readonly root: string, private readonly security: StateSecurityDeps = {},
    private readonly processes: AdmissionProcessInspector = createAdmissionProcessInspector()) {
    this.directory = join(root, 'native-writers')
  }

  private async reconcile(): Promise<void> {
    const entries = await readdir(this.directory)
    // Fully published claims and unpublished metadata drafts have distinct
    // names. A crash before rename never sent the helper's stdin gate.
    for (const name of entries.filter((entry) => entry.endsWith('.new'))) {
      if (!/^[a-f0-9-]{36}\.json\.[1-9][0-9]*\.[a-f0-9-]{36}\.new$/u.test(name)) return fail()
      const path = join(this.directory, name)
      await assertOwnerOnlyStatePath(path, 'file', this.security)
      const entry = await lstat(path)
      if (entry.nlink !== 1 || entry.size > 4096) return fail()
      await unlink(path)
    }
    let live = 0
    for (const name of entries.filter((entry) => !entry.endsWith('.new'))) {
      if (!/^[a-f0-9-]{36}\.json$/u.test(name)) return fail()
      const path = join(this.directory, name)
      await assertOwnerOnlyStatePath(path, 'file', this.security)
      const before = await lstat(path)
      if (before.nlink !== 1 || before.size > 4096) return fail()
      let claim: Claim
      try { claim = JSON.parse(await readFile(path, 'utf8')) as Claim } catch { return fail() }
      if (claim.version !== 1 || !Number.isSafeInteger(claim.pid) || claim.pid < 1
        || typeof claim.startedAt !== 'string' || !/^[0-9]+$/u.test(claim.startedAt)
        || claim.token !== name.slice(0, -5)) return fail()
      const current = await this.processes.identify(claim.pid)
      if (current?.startedAt === claim.startedAt || !current && this.processes.isAlive(claim.pid)) {
        live += 1
        continue
      }
      const after = await lstat(path)
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) return fail()
      await unlink(path)
    }
    // Historical files cannot disable recovery. Any unresolved live writer
    // remains an admission fence after abandoned metadata has been removed.
    if (live > 0) return fail()
  }

  async execute<T>(
    work: (track: (child: Pick<ChildProcess, 'pid'>) => Promise<() => Promise<void>>) => Promise<T>,
  ): Promise<T> {
    await ensureOwnerOnlyStateDirectory(this.directory, this.security)
    const lock = await acquireOwnerStateLock(this.root, 'native-writer-admission.lock', { security: this.security })
    let holding = true
    try {
      await this.reconcile()
      return await work(async (child) => {
        if (!child.pid) return fail()
        const identity = await this.processes.identify(child.pid)
        if (!identity || identity.pid !== child.pid || !/^[0-9]+$/u.test(identity.startedAt)) return fail()
        const token = randomUUID()
        const path = join(this.directory, `${token}.json`)
        await replaceOwnerOnlyJson(path, { version: 1, ...identity, token }, this.security)
        // Called only by the child exit/close event, never because kill() was
        // requested. A parent crash or unknown close leaves the claim for recovery.
        return async () => {
          const cleanup = async () => unlink(path).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          })
          if (holding) { await cleanup(); return }
          const cleanupLock = await acquireOwnerStateLock(this.root, 'native-writer-admission.lock', {
            security: this.security,
          })
          try { await cleanup() } finally { await cleanupLock.release() }
        }
      })
    } finally { holding = false; await lock.release() }
  }
}
