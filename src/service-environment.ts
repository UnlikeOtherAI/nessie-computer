import { spawn } from 'node:child_process'
import { lstat, readdir } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { assertPackagedExecutorRuntime } from './runtime-integrity.js'
import { loadExecutorState } from './state-store.js'

const SERVICE_STATE_DIRECTORY = '.local/state/nessie-executor'
const EXECUTOR_STATE_FILE = 'executor-state.json'
const MAX_CAPTURED_OUTPUT = 16_384

export type ExecutorServiceCommandResult = { code: number; stdout: string }

export type ExecutorServiceEnvironment = {
  confirm: (question: string) => Promise<boolean>
  home: string
  interactive: boolean
  listStateDirectories: (stateRoot: string) => Promise<string[]>
  loadPairedState: (stateDir: string) => Promise<void>
  platform: NodeJS.Platform
  run: (file: string, args: string[]) => Promise<ExecutorServiceCommandResult>
  username: string
  verifyPackagedRuntime: () => Promise<void>
  write: (line: string) => void
}

const spawnCommand = (file: string, args: string[]): Promise<ExecutorServiceCommandResult> => (
  new Promise((settle, fail) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'inherit'] })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_CAPTURED_OUTPUT) stdout += chunk
    })
    child.once('error', () => fail(new Error(`${file} is not available on this host.`)))
    child.once('close', (code, signal) => settle({ code: code ?? (signal ? 1 : 0), stdout }))
  })
)

/** The same rule the desktop applies to an executor id: it becomes a path segment. */
const validIdentifier = (value: string): boolean => (
  value.length > 0 && value.length <= 128 && /^[A-Za-z0-9-]+$/.test(value)
)

const pairedExecutorDirectories = async (stateRoot: string): Promise<string[]> => {
  let entries: string[]
  try {
    entries = await readdir(stateRoot)
  } catch {
    return []
  }
  const paired: string[] = []
  for (const name of entries.sort()) {
    if (!validIdentifier(name)) continue
    try {
      const directory = await lstat(join(stateRoot, name))
      if (directory.isSymbolicLink() || !directory.isDirectory()) continue
      const state = await lstat(join(stateRoot, name, EXECUTOR_STATE_FILE))
      if (!state.isSymbolicLink() && state.isFile()) paired.push(name)
    } catch {
      continue
    }
  }
  return paired
}

export const createExecutorServiceEnvironment = (): ExecutorServiceEnvironment => ({
  confirm: async (question: string) => {
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const answer = (await prompt.question(`${question} [y/N] `)).trim().toLowerCase()
      return answer === 'y' || answer === 'yes'
    } finally {
      prompt.close()
    }
  },
  home: homedir(),
  interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  listStateDirectories: pairedExecutorDirectories,
  loadPairedState: async (stateDir: string) => {
    await loadExecutorState(stateDir)
  },
  platform: process.platform,
  run: spawnCommand,
  username: userInfo().username,
  verifyPackagedRuntime: assertPackagedExecutorRuntime,
  write: (line: string) => process.stdout.write(`${line}\n`),
})

export const assertExecutorIdentifier = (value: string): string => {
  if (!validIdentifier(value)) throw new Error('The executor id is malformed.')
  return value
}

export const executorServiceStateRoot = (home: string): string => resolve(home, SERVICE_STATE_DIRECTORY)
