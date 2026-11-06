import { createInterface } from 'node:readline/promises'
import { localUpdate } from './native-client.js'
import type { ExecutorLocalUpdateRequest, ExecutorLocalUpdateStatus } from '@nessie/executor-protocol'

const usage = 'Usage: nessie-executor updates [status|check|install|remind|automatic on|automatic off] [--json]'

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
  throw new Error(usage)
}

const describe = (status: ExecutorLocalUpdateStatus): string => [
  `Nessie Computer ${status.installedVersion}`,
  ...(status.phase === 'unsupported' ? ['Update this installation with its package manager.'] : [
    `Automatic updates: ${status.automatic ? 'on' : 'off'}.`,
    ...(status.availableVersion ? [`Version ${status.availableVersion} is available.`] : []),
    ...(status.phase === 'waiting' ? ['The update will wait for active work to finish.'] : []),
    ...(status.phase === 'failed' ? ['The update failed. Run nessie-executor updates install to retry.'] : []),
  ]),
].join('\n')

export const runUpdateCli = async (args: string[]): Promise<boolean> => {
  const command = parseUpdateArguments(args)
  if (!command) return false
  const status = await localUpdate(command.request)
  process.stdout.write(command.json ? `${JSON.stringify(status)}\n` : `${describe(status)}\n`)
  return true
}

/** Only human terminals get a prompt. Built-in servers and JSON output keep their wire contract. */
export const offerUpdateAtLaunch = async (args: string[]): Promise<boolean> => {
  if (!process.stdin.isTTY || !process.stderr.isTTY || args.includes('--json')) return false
  try {
    const status = await localUpdate({ operation: 'check' })
    if (!status.canInstall || !status.notify || !status.availableVersion) return false
    const terminal = createInterface({ input: process.stdin, output: process.stderr })
    try {
      const answer = await terminal.question(
        `Nessie Computer ${status.availableVersion} is available. [u] Update now, [r] remind me tomorrow, [Enter] continue: `,
      )
      if (answer.trim().toLowerCase() === 'r') await localUpdate({ operation: 'remind' })
      if (answer.trim().toLowerCase() !== 'u') return false
      await localUpdate({ operation: 'install' })
      process.stderr.write('Update requested. Active work will finish before installation.\n')
      // Leaving this old runtime allows its native launch lease to drain.
      return true
    } finally { terminal.close() }
  } catch { return false }
}
