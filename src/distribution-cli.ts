import { executorSoftwareVersion } from './updates/version.js'

export const runDistributionCli = (args: string[]): boolean => {
  if (args.length !== 1 || !['--version', '-v'].includes(args[0] ?? '')) return false
  const version = executorSoftwareVersion()
  process.stdout.write(`nessie-executor ${version}\n`)
  return true
}
