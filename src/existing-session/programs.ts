import { access, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveProgramPath } from '../coding-session/program-path.js'
import { runCommand } from '../coding-session/agent-env.js'
import type { ExistingProvider } from './types.js'

export type ProviderProgram = { path: string; version: string }

/** Native executables only: no shell, npm script shim, model-supplied path or working-directory lookup. */
export const findProviderProgram = async (
  provider: ExistingProvider, env: NodeJS.ProcessEnv,
): Promise<ProviderProgram | undefined> => {
  const home = homedir()
  const candidates: string[] = []
  if (provider === 'codex' && process.platform === 'darwin') {
    candidates.push('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
  }
  if (provider === 'codex' && process.platform === 'win32') {
    const directory = join(home, 'AppData', 'Local', 'OpenAI', 'Codex', 'bin')
    const versions = await readdir(directory, { withFileTypes: true }).catch(() => [])
    const installed = await Promise.all(versions.filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(directory, entry.name, 'codex.exe')
        return { path, modified: await stat(path).then((info) => info.mtimeMs, () => 0) }
      }))
    candidates.push(...installed.sort((left, right) => right.modified - left.modified)
      .slice(0, 64).map((entry) => entry.path))
  }
  if (provider === 'claude' && process.platform === 'win32') {
    candidates.push(join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'))
  }
  const fromPath = await resolveProgramPath(provider, env)
  if (fromPath) candidates.push(fromPath)
  candidates.push(join(home, '.local', 'bin', process.platform === 'win32' ? `${provider}.exe` : provider))
  for (const candidate of [...new Set(candidates)]) {
    if (!await access(candidate).then(() => true, () => false)) continue
    const result = await runCommand(candidate, ['--version'], { env, timeoutMs: 5_000, maxBytes: 4_096 })
    if (result.code === 0) return { path: candidate, version: result.stdout.trim().slice(0, 100) }
  }
  return undefined
}
