import { spawn } from 'node:child_process'
import { executorChildCommand } from './executor-child-command.js'
import { windowsServiceExecutorId } from './chatgpt-windows-service-authority.js'

export const launchChatgptCredential = async (
  stateDirectory: string, profileId: string, operationId: string,
  retainOwner: (stopped: Promise<void>) => void,
): Promise<{ stopped: Promise<void> }> => {
  const command = executorChildCommand({ execPath: process.execPath, execArgv: process.execArgv,
    entry: process.argv[1]!, packaged: process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1' },
  ['personal-chatgpt-credential', windowsServiceExecutorId(stateDirectory) ? '--service-executor' : '--state-dir',
    windowsServiceExecutorId(stateDirectory) ?? stateDirectory,
    '--profile-id', profileId, '--operation-id', operationId])
  let closed!: Promise<void>
  await new Promise<void>((done, reject) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    // The outer native supervisor retains the entire descendant tree. This
    // controller remains foreground and never treats unref as tree clearance.
    closed = new Promise<void>(resolve => { child.once('close', () => resolve()) })
    // Ownership survives ACK timeout/error. The public controller still waits
    // for actual tree close, while another status operation can inspect it.
    retainOwner(closed)
    let output = ''
    let settled = false
    const timer = setTimeout(() => finish(new Error('credential_start_deferred')), 15000)
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!error) child.stdout?.destroy()
      if (error) reject(error)
      else done()
    }
    child.once('error', finish)
    child.once('close', () => { if (!output.includes('\n')) finish(new Error('credential_start_failed')) })
    child.stdout?.on('data', (bytes: Buffer) => {
      if (settled) return // Drain late public ACKs; do not create an EPIPE writer.
      output += bytes.toString('utf8')
      if (output.length > 1024) finish(new Error('credential_start_failed'))
      else if (output.includes('\n')) {
        finish(output === '{"started":true}\n' ? undefined : new Error('credential_start_failed'))
      }
    })
  })
  return { stopped: closed }
}

