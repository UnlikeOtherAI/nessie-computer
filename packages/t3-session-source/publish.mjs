import { randomUUID } from 'node:crypto'
import { rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

/** Publish only a completed package generation. Windows readers/scanners can
 * briefly deny directory renames; retry that same operation within five seconds.
 * Never remove an output or replace a denied rename with per-file overwrites. */
export async function publishSessionPackage(packageRoot, generation,
  { renameDirectory = rename, platform = process.platform } = {}) {
  const root = resolve(packageRoot), output = resolve(generation)
  const generations = resolve(root, '.artifacts/package-builds')
  if (dirname(output) !== generations) throw new Error('SESSION_PACKAGE_GENERATION_PATH_REFUSED')
  const dist = resolve(root, 'dist'), previous = resolve(generations, `previous-${randomUUID()}`)
  const move = async (from, to) => {
    const deadline = performance.now() + 5_000
    for (;;) {
      try { await renameDirectory(from, to); return }
      catch (error) {
        const remaining = deadline - performance.now()
        if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || remaining <= 0) throw error
        await setTimeout(Math.min(100, remaining))
      }
    }
  }
  let hadPrevious = false
  try { await move(dist, previous); hadPrevious = true }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  try { await move(output, dist) }
  catch (error) {
    if (hadPrevious) {
      try { await move(previous, dist) }
      catch (restore) { throw new AggregateError([error, restore], 'SESSION_PACKAGE_RESTORE_FAILED') }
    }
    throw error
  }
}
