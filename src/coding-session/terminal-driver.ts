import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

import { ExecutorSessionScreenSchema, type ExecutorSessionScreen } from '@nessie/executor-protocol'

import { AgentStartError, startAgentProcess, type AgentDriver, type AgentDriverContext, type AgentProcess } from './agent-process.js'
import { resolveExecutorEntry } from './host-spawn.js'
import { createDebouncedJsonWriter, writeJsonAtomic } from './session-files.js'
import { packagedJobHelper } from './process-control.js'

export const createTerminalDriver = (context: AgentDriverContext): AgentDriver => {
  let process: AgentProcess | undefined
  let screen: ExecutorSessionScreen = {
    ansi: '', cols: 120, rows: 36, capturedAt: new Date().toISOString(), kind: 'terminal',
  }
  let ending = false
  // Whether the started program's ending is recorded yet. Until it is, the
  // session still counts as running, so its host cannot leave in the moment
  // after the exit and leave the session reading as lost rather than closed or
  // failed with its exit code.
  let settled = true
  const writer = createDebouncedJsonWriter(
    join(context.paths.dir, 'terminal.json'), () => screen, context.log, 100, context.stillOwner,
  )
  const start = async (): Promise<AgentProcess> => {
    if (!await context.stillOwner()) throw new AgentStartError('host_superseded')
    // PTYs cannot resume a killed process. The closed screen remains readable;
    // a fresh session is required rather than silently replaying its commands.
    if (context.state().turn > 0) throw new AgentStartError('terminal_process_ended')
    const execArgv = globalThis.process.execArgv.map((arg) => (
      arg === 'tsx' ? pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href : arg
    ))
    const helperContext = { ...context, env: {
      ...context.env,
      ...(globalThis.process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1' ? { NESSIE_EXECUTOR_PACKAGED_CLI: '1' } : {}),
    } }
    const child = await startAgentProcess(helperContext, [
      globalThis.process.execPath, ...execArgv, resolveExecutorEntry(), 'terminal-session-process',
    ], (line) => {
      try {
        const message = JSON.parse(line) as { socketPath?: unknown }
        if (typeof message.socketPath === 'string') {
          void writeJsonAtomic(join(context.paths.dir, 'terminal-connection.json'), {
            socketPath: message.socketPath, session: 'nessie',
          }).catch(() => undefined)
        }
        const parsed = ExecutorSessionScreenSchema.safeParse(message)
        if (parsed.success) { screen = parsed.data; writer.schedule() }
      } catch { /* A malformed helper frame never becomes terminal content. */ }
    })
    process = child
    // One program for the session's whole life, not a turn: no turn limit applies to it (host.ts).
    context.update({ agentIdentity: child.identity, status: 'working', turn: 1 })
    const argv = [...context.agent.command, ...context.agent.args]
    if (globalThis.process.platform === 'win32') {
      const helper = packagedJobHelper() ?? (globalThis.process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1'
        ? undefined : fileURLToPath(new URL('../../native/target/release/nessie-executor-native.exe', import.meta.url)))
      if (!helper) throw new AgentStartError('terminal_helper_missing')
      argv.unshift(helper, 'terminal-run', '--')
    }
    child.write(`${JSON.stringify(argv)}\n`)
    settled = false
    void child.exited.then(async ({ code }) => {
      await writer.flush()
      if (!ending) context.update({
        status: code === 0 ? 'closed' : 'failed', reason: code === 0 ? undefined : 'terminal_process_ended',
        ...(code === null ? {} : { exitCode: code }),
        ...(!child.confirmHostExecutionStopped ? { agentIdentity: undefined } : {}), turnStartedAt: undefined,
      })
    }).finally(() => { settled = true })
    return child
  }
  const stop = async (): Promise<void> => {
    ending = true
    if (process) {
      const descendants = await context.control.descendants(process.identity)
      const stopped = process.confirmHostExecutionStopped
        ? await process.confirmHostExecutionStopped(descendants)
        : (await context.control.killTree(process.identity, descendants), true)
      await process.exited
      if (stopped) context.update({ agentIdentity: undefined })
    }
    await writer.flush()
    context.update({ turnStartedAt: undefined })
  }
  return {
    send: async (data) => {
      const child = process?.alive() ? process : await start()
      if (data) child.write(`${JSON.stringify(data)}\n`)
    },
    interrupt: async () => { process?.write(`${JSON.stringify('\u0003')}\n`) },
    close: async (reason) => { await stop(); context.update({ status: 'closed', reason }) },
    endIdle: stop,
    running: () => process?.alive() === true || !settled,
    busy: () => process?.alive() === true || !settled,
  }
}
