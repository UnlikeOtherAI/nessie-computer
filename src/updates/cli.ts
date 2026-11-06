import { createInterface } from 'node:readline/promises'
import { localUpdate } from './native-client.js'
import { cliUpdateWords } from './words.js'
import type { ExecutorLocalUpdateRequest, ExecutorLocalUpdateStatus } from '@nessie/executor-protocol'

const usage = 'Usage: nessie-executor updates '
  + '[status|check|install|remind|automatic on|automatic off|channel stable|channel preview] [--json]'

export const parseUpdateArguments = (args: string[]): {
  request: ExecutorLocalUpdateRequest; json: boolean
} | undefined => {
  if (args[0] !== 'updates') return undefined
  const values = args.slice(1)
  const json = values.at(-1) === '--json'
  if (json) values.pop()
  if (values.length === 0) return { request: { operation: 'status' }, json }
  if (values.length === 1 && ['status', 'check', 'install', 'remind'].includes(values[0] ?? '')) {
    return { request: { operation: values[0] as 'status' | 'check' | 'install' | 'remind' }, json }
  }
  if (values.length === 2 && values[0] === 'automatic' && ['on', 'off'].includes(values[1] ?? '')) {
    return { request: { operation: 'automatic', enabled: values[1] === 'on' }, json }
  }
  if (values.length === 2 && values[0] === 'channel' && ['stable', 'preview'].includes(values[1] ?? '')) {
    return { request: { operation: 'channel', channel: values[1] as 'stable' | 'preview' }, json }
  }
  throw new Error(usage)
}

const describe = (status: ExecutorLocalUpdateStatus): string => {
  const words = cliUpdateWords()
  return [
  `Nessie Computer ${status.installedVersion}`,
  words.channel.replace('{channel}', status.channel),
  ...(status.phase === 'unsupported' ? [words.unsupported] : [
    status.automatic ? words.on : words.off,
    ...(status.availableVersion ? [words.available.replace('{version}', status.availableVersion)] : []),
    ...(status.phase === 'waiting' ? [words.waiting] : []),
    ...(status.phase === 'failed' ? [words.failed] : []),
  ]),
].join('\n')
}

export const runUpdateCli = async (args: string[]): Promise<boolean> => {
  const command = parseUpdateArguments(args)
  if (!command) return false
  const status = await localUpdate(command.request).catch(() => { throw new Error(cliUpdateWords().unavailable) })
  const acknowledgement = command.request.operation === 'install' ? `${cliUpdateWords().requested}\n` : ''
  process.stdout.write(command.json ? `${JSON.stringify(status)}\n` : `${acknowledgement}${describe(status)}\n`)
  return true
}

/** Only human terminals get a prompt. Built-in servers and JSON output keep their wire contract. */
export const offerUpdateAtLaunch = async (args: string[]): Promise<boolean> => {
  if (!process.stdin.isTTY || !process.stderr.isTTY || args.includes('--json')) return false
  const words = cliUpdateWords()
  let chosen = false
  try {
    let status = await localUpdate({ operation: 'check' })
    const deadline = Date.now() + 5_000
    while (status.canInstall && status.phase === 'checking' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200))
      status = await localUpdate({ operation: 'status' })
    }
    if (!status.canInstall || !status.notify || !status.availableVersion
      || ['downloading', 'waiting', 'installing', 'restarting'].includes(status.phase)) return false
    const terminal = createInterface({ input: process.stdin, output: process.stderr })
    try {
      const answer = await terminal.question(
        words.prompt.replace('{version}', status.availableVersion),
      )
      chosen = ['r', 'u'].includes(answer.trim().toLowerCase())
      if (answer.trim().toLowerCase() === 'r') await localUpdate({ operation: 'remind' })
      if (answer.trim().toLowerCase() !== 'u') return false
      await localUpdate({ operation: 'install' })
      process.stderr.write(`${words.requested}\n`)
      // Leaving this old runtime allows its native launch lease to drain.
      return true
    } finally { terminal.close() }
  } catch {
    if (chosen) process.stderr.write(`${words.requestFailed}\n`)
    return false
  }
}
