import { randomUUID } from 'node:crypto'

import { acceptOnly, operands } from './cli-options.js'
import { CliRefusal, CliUsageError, columns, printJson, type CliContext } from './cli-output.js'
import type { InferenceStatus as Status } from './cli-team-ops.js'
import type { CliRun } from './cli-user.js'

/**
 * `ai servers`: Model servers on the AI tab, through the same status and
 * operation functions `local-inference connections` runs for the apps (the
 * service's `inferenceConnections` for a team the Windows service runs).
 */

const KEY_LIMIT = 4_096

const readKey = async (context: CliContext): Promise<string> => {
  let text = ''
  for await (const chunk of context.stdin) {
    text += String(chunk)
    if (text.length > KEY_LIMIT + 2) throw new CliUsageError('The API key on standard input is too long.', 'ai servers')
  }
  const key = text.replace(/\r?\n$/u, '')
  if (!key || /[\r\n]/u.test(key)) throw new CliUsageError('Give the API key as one line on standard input.', 'ai servers')
  return key
}

const print = (run: CliRun, label: string, status: Status): void => {
  if (run.options.json) {
    printJson(run.context, status)
    return
  }
  if (!status.endpoints.length) {
    run.context.out(`No model servers for ${label}.\n`)
    return
  }
  run.context.out(`Model servers for ${label}:\n${columns(status.endpoints.map((endpoint) => [endpoint.name, endpoint.baseUrl,
    endpoint.scope === 'network' ? 'on the network' : 'this computer', endpoint.status === 'online'
      ? `online${endpoint.models.length ? ` (${endpoint.models.join(', ')})` : ''}` : 'offline']), '  ')}\n`)
}

export const runAiServers = async (run: CliRun): Promise<void> => {
  const [action = 'list', ...rest] = operands(run.options, 2, 2, 'ai servers')
  acceptOnly(run.options, 'ai servers', action === 'add' ? ['--where', '--key-stdin'] : [])
  const team = await run.team()
  const ops = run.ops(team)
  const status = () => ops.inference({ operation: 'status' })
  if (action === 'list' || action === 'check') {
    if (rest.length) throw new CliUsageError(`ai servers ${action} takes nothing after it.`, 'ai servers')
    print(run, team.label, await status())
    return
  }
  if (action === 'add') {
    const [name, address] = rest
    if (!name || !address) throw new CliUsageError('Use ai servers add <name> <address>.', 'ai servers')
    const where = run.options.values.get('--where') ?? 'this-computer'
    if (where !== 'this-computer' && where !== 'network') {
      throw new CliUsageError('Use --where this-computer or --where network.', 'ai servers')
    }
    const existing = (await status()).endpoints.find((endpoint) => endpoint.name === name)
    if (existing) throw new CliRefusal('MODEL_SERVER_LISTED', `${team.label} already has a model server called ${name}.`)
    const apiKey = run.options.flags.has('--key-stdin') ? await readKey(run.context) : undefined
    print(run, team.label, await ops.inference({ operation: 'save', id: randomUUID(), name, baseUrl: address,
      scope: where === 'network' ? 'network' : 'local', ...(apiKey ? { apiKey } : {}) }))
    return
  }
  if (action === 'remove') {
    const [name, extra] = rest
    if (!name || extra !== undefined) throw new CliUsageError('Use ai servers remove <name>.', 'ai servers')
    const existing = (await status()).endpoints.find((endpoint) => endpoint.name === name)
    if (!existing) throw new CliRefusal('MODEL_SERVER_NOT_FOUND', `${team.label} has no model server called ${name}.`)
    print(run, team.label, await ops.inference({ operation: 'remove', id: existing.id }))
    return
  }
  throw new CliUsageError(`ai servers has no "${action}". Use list, add, check or remove.`, 'ai servers')
}
