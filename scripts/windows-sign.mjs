import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Sign Windows executables before any manifest hashes or installer payloads
 * are produced. The command has the same `%1` contract as Tauri's
 * `signCommand`, so the release owns one signing configuration.
 */
export const signWindowsArtifacts = async (
  paths,
  template = process.env.NESSIE_WINDOWS_SIGN_COMMAND,
) => {
  if (!template) return false
  if (!template.includes('%1')) {
    throw new Error('NESSIE_WINDOWS_SIGN_COMMAND must contain %1, the file being signed.')
  }
  for (const path of paths) {
    await run(template.replace('%1', `"${path}"`), { shell: true })
  }
  return true
}
