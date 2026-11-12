import path from 'node:path'

export type ExecutorChildRuntime = {
  execPath: string; execArgv: readonly string[]; entry: string; packaged: boolean
}

/** Every eligible compiled child joins its fixed native creation path. */
export const executorChildCommand = (
  runtime: ExecutorChildRuntime, arguments_: readonly string[], platform: NodeJS.Platform = process.platform,
): string[] => {
  const { basename, dirname, join, resolve } = platform === 'win32' ? path.win32 : path.posix
  if (runtime.packaged) {
    const directory = dirname(resolve(runtime.execPath))
    const managed = platform === 'linux' && /^\/usr\/lib\/nessie-executor\/releases\/[a-f0-9]{64}$/u.test(directory)
      || platform === 'darwin' && /^\/Library\/Application Support\/Nessie Executor\/releases\/[a-f0-9]{64}$/u.test(directory)
      || platform === 'win32' && basename(runtime.execPath) === 'nessie-executor-runtime.exe'
    if (managed) {
      const executable = platform === 'win32' ? 'nessie-executor-runtime.exe' : 'nessie-executor-runtime'
      if (runtime.execArgv.length !== 0 || resolve(runtime.entry) !== join(directory, 'nessie-executor.cjs')
        || resolve(runtime.execPath) !== join(directory, executable)) {
        throw new Error('A managed child process must use its fixed release without Node loader arguments.')
      }
      return [join(directory, platform === 'win32' ? 'nessie-executor-native.exe' : 'nessie-executor-native'),
        'managed-runtime', '--', ...arguments_]
    }
  }
  // Development and older local-only packages keep their existing command.
  // They cannot satisfy the independent personal runtime inventory.
  return [runtime.execPath, ...runtime.execArgv, runtime.entry, ...arguments_]
}
