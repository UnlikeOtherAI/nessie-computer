import { spawn } from 'node:child_process'

import { WorkspacePathError } from '../workspace-paths.js'
import type { HyperVProcessRunner } from './vm.js'

/** A create script prints one small JSON object; nothing prints more. */
const MAX_OUTPUT_BYTES = 64 * 1024

/**
 * Runs one pinned script. `argv` is a list, never a composed command string:
 * a session directory, a workspace path or a VM name can never become a
 * PowerShell expression, and `powerShellArgv` has already refused any value
 * carrying a newline or a NUL.
 *
 * Standard error is read and discarded rather than ignored, because a script
 * that writes more than the pipe buffer would otherwise block forever.
 */
export const runPowerShell: HyperVProcessRunner = async ({ argv, path, timeoutMs }) =>
  new Promise<string>((resolvePromise, reject) => {
    const child = spawn(path, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    let overflowed = false
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new WorkspacePathError('An executor guest VM operation timed out.'))
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (output.length + chunk.length > MAX_OUTPUT_BYTES) {
        overflowed = true
        return
      }
      output += chunk
    })
    child.stderr?.resume()
    child.once('error', () => {
      clearTimeout(timeout)
      reject(new WorkspacePathError('Windows PowerShell is unavailable, so a guest VM cannot be managed.'))
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0 || overflowed) {
        reject(new WorkspacePathError('An executor guest VM operation failed on this computer.'))
        return
      }
      resolvePromise(output)
    })
  })
