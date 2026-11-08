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

/** Human terminals get an offer; a check never consumes input or delays their command. */
export const offerUpdateAtLaunch = (args: string[], {
  terminal = process.stdin.isTTY && process.stderr.isTTY,
  check = () => localUpdate({ operation: 'check' }, { background: true }),
  write = (message: string) => { process.stderr.write(message) },
}: {
  terminal?: boolean; check?: () => Promise<ExecutorLocalUpdateStatus>; write?: (message: string) => void
} = {}): void => {
  if (!terminal || args.includes('--json')) return
  void check().then(status => {
    if (!status.canInstall || !status.notify || !status.availableVersion
      || ['downloading', 'waiting', 'installing', 'restarting'].includes(status.phase)) return
    write(cliUpdateWords().prompt.replace('{version}', status.availableVersion) + '\n')
  }).catch(() => { /* An unavailable updater never changes command output or exit status. */ })
}
