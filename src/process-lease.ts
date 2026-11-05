import { open, lstat, readFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

import { assertOwnerOnlyStatePath, secureOwnerOnlyStateFile } from './state-security.js'

/**
 * The lease sits inside the executor's state directory. On POSIX its own uid
 * and mode carry the proof; on Windows it inherits that directory's explicit
 * DACL, so the directory is what gets verified — reading a Windows file mode
 * would prove nothing, since Node reports a fixed `0o666`-shaped value there.
 */
const assertOwnerOnlyLease = async (path: string): Promise<Awaited<ReturnType<typeof lstat>>> => {
  await assertOwnerOnlyStatePath(path, 'file')
  return lstat(path)
}

/**
 * Node's `process.kill` documentation states that signal `0` "can be sent to
 * test for the existence of a process" and is "a platform independent way to
 * test for the existence of a process" — Windows has no signals, and this is
 * one of the cases Node emulates, so no signal is delivered anywhere. `ESRCH`
 * is the only answer that proves absence — `EPERM` means the process exists and
 * belongs to somebody else — so anything else is treated as alive.
 */
const processIsLive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    return true
  }
}

const staleLease = async (path: string): Promise<boolean> => {
  const value = (await readFile(path, 'utf8')).trim()
  if (!/^[1-9][0-9]{0,9}$/.test(value)) {
    throw new Error('Executor daemon lease is malformed.')
  }
  return !processIsLive(Number(value))
}

export type ExecutorDaemonLease = { release: () => Promise<void> }

/**
 * A secure, process-lifetime lease prevents an app restart from starting a
 * second daemon for the same executor while the first one still tears down its
 * guest sessions. The lease is not an authorization proof; the server's
 * connection epoch remains the distributed fence.
 */
export const acquireExecutorProcessLease = async (
  stateDir: string, name: 'daemon.pid' | 'pairing-operation.pid',
): Promise<ExecutorDaemonLease> => {
  const path = resolve(stateDir, name)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(`${process.pid}\n`, 'utf8')
        await secureOwnerOnlyStateFile(path)
        const metadata = await assertOwnerOnlyLease(path)
        return {
          release: async () => {
            const current = await assertOwnerOnlyLease(path).catch(() => undefined)
            if (current?.ino === metadata.ino) await unlink(path).catch(() => undefined)
          },
        }
      } catch (error) {
        await unlink(path).catch(() => undefined)
        throw error
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await assertOwnerOnlyLease(path)
      if (!await staleLease(path)) {
        throw new Error(name === 'daemon.pid' ? 'EXECUTOR_DAEMON_ALREADY_RUNNING' : 'Pairing is busy. Try again in a moment.')
      }
      await unlink(path)
    }
  }
  throw new Error('EXECUTOR_DAEMON_LEASE_RACE')
}
