import { TerminalEffectOutcomes } from './terminal-effect-frame.js'
import type { SessionEffectAuthority } from './session-effect-authority.js'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { executorChildCommand } from '../executor-child-command.js'

import { ExecutorSessionScreenSchema, type ExecutorSessionScreen } from '@nessie/executor-protocol'

import { AgentProcessStopUnproved, AgentStartError, startAgentProcess, type AgentDriver, type AgentDriverContext, type AgentProcess } from './agent-process.js'
import { resolveExecutorEntry } from './host-spawn.js'
import { createDebouncedJsonWriter, writeJsonAtomic } from './session-files.js'
import { packagedJobHelper } from './process-control.js'

export const createTerminalDriver = (context: AgentDriverContext): AgentDriver => {
  const outcomes = new TerminalEffectOutcomes()
  let process: AgentProcess | undefined
  let screen: ExecutorSessionScreen = {
    ansi: '', cols: 120, rows: 36, capturedAt: new Date().toISOString(), kind: 'terminal',
  }
  let ending = false
  let stopDebt: AgentProcessStopUnproved | undefined
  // Whether the started program's ending is recorded yet. Until it is, the
  // session still counts as running, so its host cannot leave in the moment
  // after the exit and leave the session reading as lost rather than closed or
  // failed with its exit code.
  let settled = true
  const writer = createDebouncedJsonWriter(
    join(context.paths.dir, 'terminal.json'), () => screen, context.log, 100, context.stillOwner,
  )
  const start = async (effect?: SessionEffectAuthority): Promise<AgentProcess> => {
    if (stopDebt) throw stopDebt
    if (!await context.stillOwner()) throw new AgentStartError('host_superseded')
    // PTYs cannot resume a killed process. The closed screen remains readable;
    // a fresh session is required rather than silently replaying its commands.
    if (context.state().turn > 0) throw new AgentStartError('terminal_process_ended')
    const execArgv = globalThis.process.execArgv.map((arg) => (
      arg === 'tsx' ? pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href : arg
    ))
    const helperContext = { ...context, env: {
      ...context.env,
      ...(effect ? { NESSIE_SESSION_EFFECT_REQUIRED: '1' } : {}),
      ...(globalThis.process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1' ? { NESSIE_EXECUTOR_PACKAGED_CLI: '1' } : {}),
    } }
    const terminalCommand = executorChildCommand({
      execPath: globalThis.process.execPath, execArgv, entry: resolveExecutorEntry(),
      packaged: globalThis.process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1',
    }, ['terminal-session-process'])
    const child = await startAgentProcess(helperContext, terminalCommand, (line) => {
      try {
        const message = JSON.parse(line) as { socketPath?: unknown }
        if (outcomes.accept(message)) return
        if (typeof message.socketPath === 'string') {
          void writeJsonAtomic(join(context.paths.dir, 'terminal-connection.json'), {
            socketPath: message.socketPath, session: 'nessie',
          }).catch(() => undefined)
        }
        const parsed = ExecutorSessionScreenSchema.safeParse(message)
        if (parsed.success) { screen = parsed.data; writer.schedule() }
      } catch { /* A malformed helper frame never becomes terminal content. */ }
    }, effect).catch(error => {
      if (error instanceof AgentProcessStopUnproved) {
        stopDebt = error
        if (error.identity) context.update({ agentIdentity: error.identity })
      }
      throw error
    })
    process = child
    // One program for the session's whole life, not a turn: no turn limit applies to it (host.ts).
    context.update({ agentIdentity: child.identity, status: 'working', turn: 1 })
    const argv = [...context.agent.command, ...context.agent.args]
    if (globalThis.process.platform === 'win32') {
      const helper = packagedJobHelper() ?? (globalThis.process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1'
        ? undefined : fileURLToPath(new URL('../../native/target/debug/nessie-executor-native.exe', import.meta.url)))
      if (!helper) throw new AgentStartError('terminal_helper_missing')
      argv.unshift(helper, effect ? 'terminal-run-authorized' : 'terminal-run', '--')
    }
    await effect?.consume()
    effect?.assertLive()
    await outcomes.send(argv, effect, child.write)
    settled = false
    void child.exited.then(async ({ code, clearance }) => {
      if (clearance === 'stopped' && process === child) process = undefined
      await writer.flush()
      if (!ending) context.update({
        status: clearance === 'unknown' ? 'interrupted' : code === 0 ? 'closed' : 'failed',
        reason: clearance === 'unknown' ? 'provider_stop_unproved' : code === 0 ? undefined : 'terminal_process_ended',
        ...(code === null ? {} : { exitCode: code }),
        ...(clearance === 'stopped' ? { agentIdentity: undefined } : {}), turnStartedAt: undefined,
      })
    }).catch(() => context.log('Terminal exit publication failed.')).finally(() => { settled = true })
    return child
  }
  const stop = async (effect?: SessionEffectAuthority): Promise<void> => {
    const current = process
    const identity = current?.identity ?? context.state().agentIdentity
    if (stopDebt && !identity) throw stopDebt
    ending = true
    try {
      if (identity) {
        const descendants = await context.control.descendants(identity)
        await effect?.consume()
        effect?.assertLive()
        const stopped = current ? await current.confirmHostExecutionStopped(descendants, effect)
          : await context.control.stopTree?.(identity, descendants, effect) === 'stopped'
        if (!stopped) throw new AgentProcessStopUnproved(identity)
        await current?.exited
        process = undefined
        stopDebt = undefined
        context.update({ agentIdentity: undefined })
      }
      await writer.flush()
      context.update({ turnStartedAt: undefined })
    } finally { ending = false }
  }
  return {
    send: async (data, _uuid, effect) => {
      const child = process?.alive() ? process : await start(effect)
      await effect?.consume()
      effect?.assertLive()
      if (data) await outcomes.send(data, effect, child.write)
    },
    interrupt: async (_reason, effect) => {
      if (process) await outcomes.send('\u0003', effect, process.write)
    },
    close: async (reason, effect) => { await stop(effect); context.update({ status: 'closed', reason }) },
    endIdle: stop,
    running: () => process !== undefined || !settled || stopDebt !== undefined || context.state().agentIdentity !== undefined,
    busy: () => process?.alive() === true || !settled,
  }
}
