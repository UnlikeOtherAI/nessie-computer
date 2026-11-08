import { spawn } from 'node:child_process'
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { LocalCliEngine } from '@nessie/executor-protocol'

import { runCommand, type CommandRunner } from './coding-session/agent-env.js'
import { localCliAccountEnvironment } from './local-cli-engine-accounts.js'

/**
 * The CLI's own sign-in and sign-out for an added account. Anthropic does not
 * permit third-party OAuth for Claude plans, so Nessie Computer never signs in
 * on a CLI's behalf: it runs `claude auth login` or `codex login` with the
 * account's own profile directory, in a terminal the owner can see.
 */
export const signInArguments = (engine: LocalCliEngine): string[] =>
  engine === 'claude-code' ? ['auth', 'login'] : ['login']

const signOutArguments = (engine: LocalCliEngine): string[] =>
  engine === 'claude-code' ? ['auth', 'logout'] : ['logout']

const variable = (engine: LocalCliEngine): string => engine === 'claude-code' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** Runs the sign-in here, in this terminal. */
export const signInHere = (engine: LocalCliEngine, program: string, env: NodeJS.ProcessEnv, directory: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(program, signInArguments(engine), {
      env: localCliAccountEnvironment(engine, env, directory), stdio: 'inherit', windowsHide: false,
    })
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? 1))
  })

/** Opens a terminal window that runs the sign-in, for the apps; answers once the window is asked for. */
export const signInInTerminal = async (
  engine: LocalCliEngine, program: string, directory: string,
  platform: NodeJS.Platform = process.platform,
  start: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void> = startDetached,
): Promise<void> => {
  if (platform === 'darwin') {
    const script = join(directory, 'sign-in.command')
    await writeFile(script, ['#!/bin/sh', `export ${variable(engine)}=${shellQuote(directory)}`,
      `exec ${shellQuote(program)} ${signInArguments(engine).join(' ')}`, ''].join('\n'), { mode: 0o700 })
    await chmod(script, 0o700)
    await start('/usr/bin/open', ['-a', 'Terminal', script], process.env)
    return
  }
  if (platform === 'win32') {
    if (/["%^&|<>]/u.test(program)) throw new Error('cli_program_path_unsupported')
    const env = localCliAccountEnvironment(engine, process.env, directory)
    await start('cmd.exe', ['/d', '/c', 'start', '"Nessie Computer"', 'cmd.exe', '/k',
      `"${program}" ${signInArguments(engine).join(' ')}`], env)
    return
  }
  throw new Error('cli_sign_in_needs_terminal')
}

const startDetached = (command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, detached: true, stdio: 'ignore',
      windowsHide: false, windowsVerbatimArguments: process.platform === 'win32' })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })

/** Signs the account's profile out with the CLI's own command before its folder is deleted. */
export const signOut = async (
  engine: LocalCliEngine, program: string, env: NodeJS.ProcessEnv, directory: string, run: CommandRunner = runCommand,
): Promise<boolean> => (await run(program, signOutArguments(engine), {
  env: localCliAccountEnvironment(engine, env, directory), timeoutMs: 20_000, maxBytes: 16 * 1024,
})).code === 0
