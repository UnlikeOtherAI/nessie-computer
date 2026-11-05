import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

/**
 * Where a bare program name — the configured `claude`, `git`, `gh` — is
 * found: the absolute entries of the environment's own `PATH`, in order, and
 * nowhere else.
 *
 * Left to itself, Windows looks in the child's working directory before
 * `PATH` (libuv's search for `execFile` and `spawn`, and `CreateProcessW`'s
 * inside the job helper), and that directory is the session's folder: a
 * repository the agent edits. A `claude.exe` committed there, or written by
 * the agent during a turn, would be what the next start, the next resume and
 * every probe ran, a program the reviewed configuration never named. POSIX
 * `execvp` honours a relative `PATH` entry, which is relative to that same
 * folder. So a program is resolved once, to an absolute path, before
 * anything runs it, and a name with a directory in it that is not absolute is
 * not resolved at all.
 */

/** A directory that means the same whatever the working directory: a drive or UNC path on Windows. */
export const absoluteDirectory = (directory: string, platform: NodeJS.Platform): boolean => (
  platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/u.test(directory) : posix.isAbsolute(directory)
)

const runnable = async (candidate: string, platform: NodeJS.Platform): Promise<boolean> => {
  if (!await stat(candidate).then((info) => info.isFile(), () => false)) return false
  return platform === 'win32' || access(candidate, constants.X_OK).then(() => true, () => false)
}

/** The value of `PATH` in `env`, by the name the OS compares it by. */
const pathOf = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string => (
  Object.entries(env).find(([name]) => (platform === 'win32' ? name.toUpperCase() === 'PATH' : name === 'PATH'))?.[1] ?? ''
)

/** `program` as an absolute path, or `undefined` when no absolute `PATH` entry holds it. */
export const resolveProgramPath = async (
  program: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> => {
  const path = platform === 'win32' ? win32 : posix
  if (absoluteDirectory(program, platform)) return program
  if (!program || /[\\/]/u.test(program) || platform === 'win32' && program.includes(':')) return undefined
  // What libuv appends to a name without an extension; one that has one is tried as it is.
  const extensions = platform === 'win32' && !path.extname(program) ? ['.com', '.exe'] : ['']
  for (const directory of pathOf(env, platform).split(platform === 'win32' ? ';' : ':')) {
    if (!absoluteDirectory(directory, platform)) continue
    for (const extension of extensions) {
      const candidate = path.join(directory, `${program}${extension}`)
      if (await runnable(candidate, platform)) return candidate
    }
  }
  return undefined
}
