declare const __NESSIE_EXECUTOR_VERSION__: string

export const runDistributionCli = (args: string[]): boolean => {
  if (args.length !== 1 || !['--version', '-v'].includes(args[0] ?? '')) return false
  const version = typeof __NESSIE_EXECUTOR_VERSION__ === 'string' ? __NESSIE_EXECUTOR_VERSION__ : 'development'
  process.stdout.write(`nessie-executor ${version}\n`)
  return true
}
