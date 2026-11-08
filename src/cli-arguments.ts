import { parseExecutorMcpServerArguments } from './mcp-server-arguments.js'
import type { ExecutorLocalMcpServer } from './mcp-servers.js'
import { parseSyncArguments, type SyncCliCommand } from './folder-sync/sync-cli.js'
import { secureApiUrl } from './pairing-origin.js'
import { PROGRAM_REQUEST_ANSWERS, type ProgramRequestAnswer } from './program-requests.js'
import { parseExecutorWorkspaceFolderArguments, type ExecutorWorkspaceFolder } from './workspace-folder-arguments.js'

/**
 * What an executor command line asks for: each command of `cli.ts` and its
 * options, read and checked before anything runs. A line this does not
 * recognise throws the usage.
 */
export type ParsedCommand =
  | {
    kind: 'pair'
    apiBaseUrl: string
    challenge?: string
    challengeFromStandardInput?: true
    enrollmentId: string
    pairingInputFromStandardInput?: true
    stateDir: string
    workspaceFolders?: ExecutorWorkspaceFolder[]
  }
  | {
    configurationInputFromStandardInput?: true
    /** Absent keeps the permitted programs; `[]` clears them. */
    commandAllowlist?: string[]
    kind: 'configure'
    /** Absent keeps the named MCP servers; `[]` removes them all. */
    mcpServers?: ExecutorLocalMcpServer[]
    nativeHelperPath?: string
    operationKeys?: string[]
    stateDir: string
    workspaceFolders?: ExecutorWorkspaceFolder[]
  }
  | {
    allowedOrigins: string[]
    guestInitrdBuilderPath: string
    guestRuntimeBundlePath: string
    kernelPath: string
    kind: 'configure-browser'
    stateDir: string
    vmHelperPath: string
  }
  | {
    codexAuthProfilePath: string
    guestInitrdBuilderPath: string
    guestRuntimeBundlePath: string
    kernelPath: string
    kind: 'configure-codex'
    stateDir: string
    vmHelperPath: string
  }
  | { kind: 'connect'; stateDir: string }
  | { json: boolean; kind: 'pause'; stateDir: string }
  | { json: boolean; kind: 'resume'; stateDir: string }
  | { json: boolean; kind: 'program-requests'; stateDir: string }
  | { json: boolean; kind: 'audience'; stateDir: string }
  | { answer: ProgramRequestAnswer; id: string; json: boolean; kind: 'program-request-answer'; stateDir: string }
  | { kind: 'serve-direct-local-inference' }
  | { kind: 'describe'; stateDir: string }
  | { kind: 'deeptest-source'; sourceGrantFile: string }
  | { executionGrantFile: string; kind: 'deeptest-execution' }
  | { inferenceGrantFile: string; kind: 'deeptest-inference' }
  | { kind: 'heartbeat'; stateDir: string }
  | {
    callerOrigin: string
    expectedExtensionOrigin: string
    kind: 'native-browser-cookie-import'
    requireDevelopmentLocalApi: boolean
    stateRoot: string
  }
  | { kind: 'serve'; parentLivenessFromStandardInput?: true; stateDir: string }
  | { kind: 'publish-deeptest-source-grant'; stateDir: string }
  | { kind: 'publish-deeptest-execution-grant'; stateDir: string }
  | { kind: 'revoke-deeptest-execution-grant'; stateDir: string }
  | { kind: 'publish-deeptest-inference-grant'; stateDir: string; engines: string[]; ollamaContextLength?: number }
  | { kind: 'revoke-deeptest-inference-grant'; stateDir: string }
  | { assumeYes: boolean; executorId: string; kind: 'enable'; stateDir?: string }
  | { executorId: string; kind: 'disable' }
  | { executorId?: string; kind: 'status'; stateRoot?: string }
  | SyncCliCommand

/**
 * A plumbing command line that is malformed or names no command. The full
 * grammar is `nessie-computer help plumbing` (`cli-help.ts`); `cli.ts` exits 2
 * for it, the Command reference's "typed wrong".
 */
export class PlumbingUsageError extends Error {
  constructor() {
    super('Usage: nessie-computer <command> [options]. That command line is not one nessie-computer knows.\n'
      + 'Run nessie-computer help for the commands, or nessie-computer help plumbing for the ones the apps use.')
    this.name = 'PlumbingUsageError'
  }
}

const usage = (): never => {
  throw new PlumbingUsageError()
}

const positional = (args: string[]): string => {
  const value = args[1]
  if (!value || value.startsWith('--')) return usage()
  return value
}

const option = (args: string[], name: string): string => {
  const index = args.indexOf(name)
  const value = index >= 0 ? args[index + 1] : undefined
  if (!value || value.startsWith('--')) return usage()
  return value
}

const pairingChallenge = (args: string[]): Pick<Extract<ParsedCommand, { kind: 'pair' }>, 'challenge' | 'challengeFromStandardInput'> => {
  const standardInput = args.includes('--challenge-stdin')
  const commandLine = args.includes('--challenge')
  if (standardInput === commandLine) return usage()
  return standardInput ? { challengeFromStandardInput: true } : { challenge: option(args, '--challenge') }
}

export const parseCommand = (args: string[]): ParsedCommand => {
  const [command] = args
  if (command === 'pair') {
    const pairingInputFromStandardInput = args.includes('--pair-input-stdin')
    if (pairingInputFromStandardInput && (
      args.includes('--challenge')
      || args.includes('--challenge-stdin')
      || args.includes('--workspace')
      || args.includes('--folder')
    )) return usage()
    return {
      apiBaseUrl: secureApiUrl(option(args, '--api')),
      enrollmentId: option(args, '--enrollment'),
      kind: 'pair',
      stateDir: option(args, '--state-dir'),
      ...(pairingInputFromStandardInput
        ? { pairingInputFromStandardInput: true }
        : { workspaceFolders: parseExecutorWorkspaceFolderArguments(args, true), ...pairingChallenge(args) }),
    }
  }
  if (command === 'configure') {
    const configurationInputFromStandardInput = args.includes('--configuration-input-stdin')
    if (configurationInputFromStandardInput && (
      args.includes('--operations')
      || args.includes('--workspace')
      || args.includes('--folder')
      || args.includes('--native-helper')
      || args.includes('--tools')
      || args.includes('--clear-tools')
      || args.includes('--mcp-server')
      || args.includes('--clear-mcp-servers')
    )) return usage()
    // Naming programs and clearing them are opposite instructions; a call that
    // carries both says nothing this command may act on.
    if (args.includes('--tools') && args.includes('--clear-tools')) return usage()
    return {
      ...(configurationInputFromStandardInput ? { configurationInputFromStandardInput: true } : {}),
      ...(!configurationInputFromStandardInput && args.includes('--tools')
        ? { commandAllowlist: option(args, '--tools').split(',').map((value) => value.trim()) }
        : {}),
      ...(!configurationInputFromStandardInput && args.includes('--clear-tools')
        ? { commandAllowlist: [] }
        : {}),
      kind: 'configure',
      ...(!configurationInputFromStandardInput && args.includes('--native-helper')
        ? { nativeHelperPath: option(args, '--native-helper') }
        : {}),
      ...(!configurationInputFromStandardInput
        ? { operationKeys: option(args, '--operations').split(',').map((value) => value.trim()) }
        : {}),
      stateDir: option(args, '--state-dir'),
      ...(!configurationInputFromStandardInput
        ? (() => {
          const folders = parseExecutorWorkspaceFolderArguments(args, false)
          return folders ? { workspaceFolders: folders } : {}
        })()
        : {}),
      ...(!configurationInputFromStandardInput
        ? (() => {
          const servers = parseExecutorMcpServerArguments(args)
          return servers ? { mcpServers: servers } : {}
        })()
        : {}),
    }
  }
  if (command === 'configure-browser') {
    return {
      allowedOrigins: option(args, '--allowed-origins').split(',').map((value) => value.trim()),
      guestInitrdBuilderPath: option(args, '--guest-initrd-builder'),
      guestRuntimeBundlePath: option(args, '--runtime-bundle'),
      kernelPath: option(args, '--kernel'),
      kind: 'configure-browser',
      stateDir: option(args, '--state-dir'),
      vmHelperPath: option(args, '--vm-helper'),
    }
  }
  if (command === 'configure-codex') {
    return {
      codexAuthProfilePath: option(args, '--auth-profile'),
      guestInitrdBuilderPath: option(args, '--guest-initrd-builder'),
      guestRuntimeBundlePath: option(args, '--runtime-bundle'),
      kernelPath: option(args, '--kernel'),
      kind: 'configure-codex',
      stateDir: option(args, '--state-dir'),
      vmHelperPath: option(args, '--vm-helper'),
    }
  }
  if (command === 'describe') {
    return { kind: 'describe', stateDir: option(args, '--state-dir') }
  }
  if (command === 'connect' || command === 'heartbeat') {
    return { kind: command, stateDir: option(args, '--state-dir') }
  }
  if (command === 'pause' || command === 'resume' || command === 'program-requests' || command === 'audience') {
    const json = args.includes('--json')
    if (args.length !== (json ? 4 : 3)) return usage()
    return { json, kind: command, stateDir: option(args, '--state-dir') }
  }
  if (command === 'program-request') {
    const json = args.includes('--json')
    const answer = option(args, '--answer')
    if (args[1] !== 'answer' || args.length !== (json ? 9 : 8)
      || !PROGRAM_REQUEST_ANSWERS.includes(answer as ProgramRequestAnswer)) return usage()
    return {
      answer: answer as ProgramRequestAnswer, id: option(args, '--id'), json,
      kind: 'program-request-answer', stateDir: option(args, '--state-dir'),
    }
  }
  if (command === 'serve-direct-local-inference') {
    if (!args.includes('--config-stdin') || args.length !== 2) return usage()
    return { kind: command }
  }
  if (command === 'deeptest-source') {
    return { kind: command, sourceGrantFile: option(args, '--source-grant-file') }
  }
  if (command === 'deeptest-execution') {
    return { executionGrantFile: option(args, '--execution-grant-file'), kind: command }
  }
  if (command === 'deeptest-inference') {
    if (args.length !== 3) return usage()
    return { inferenceGrantFile: option(args, '--inference-grant-file'), kind: command }
  }
  if (command === 'publish-deeptest-inference-grant') {
    const configured = args.includes('--ollama-context-length')
    if (!args.includes('--confirm-inference') || args.length !== (configured ? 8 : 6)) return usage()
    const engines = option(args, '--engines').split(',')
    const context = configured ? option(args, '--ollama-context-length') : undefined
    if (context !== undefined && (!engines.includes('ollama') || !/^[1-9]\d{0,6}$/u.test(context)
      || Number(context) > 1_000_000)) return usage()
    return { kind: command, stateDir: option(args, '--state-dir'), engines,
      ...(context === undefined ? {} : { ollamaContextLength: Number(context) }) }
  }
  if (command === 'revoke-deeptest-inference-grant') {
    if (args.length !== 3) return usage()
    return { kind: command, stateDir: option(args, '--state-dir') }
  }
  if (command === 'publish-deeptest-source-grant') {
    return { kind: command, stateDir: option(args, '--state-dir') }
  }
  if (command === 'publish-deeptest-execution-grant') {
    if (!args.includes('--confirm-active-testing')) return usage()
    return { kind: command, stateDir: option(args, '--state-dir') }
  }
  if (command === 'revoke-deeptest-execution-grant') {
    return { kind: command, stateDir: option(args, '--state-dir') }
  }
  if (command === 'native-browser-cookie-import') {
    return {
      callerOrigin: option(args, '--caller-origin'),
      expectedExtensionOrigin: option(args, '--extension-origin'),
      kind: command,
      requireDevelopmentLocalApi: args.includes('--development-local-api'),
      stateRoot: option(args, '--state-root'),
    }
  }
  if (command === 'enable') {
    return {
      assumeYes: args.includes('--yes'),
      executorId: positional(args),
      kind: 'enable',
      ...(args.includes('--state-dir') ? { stateDir: option(args, '--state-dir') } : {}),
    }
  }
  if (command === 'disable') {
    return { executorId: positional(args), kind: 'disable' }
  }
  if (command === 'status') {
    const named = args[1] !== undefined && !args[1].startsWith('--')
    return {
      ...(named ? { executorId: positional(args) } : {}),
      kind: 'status',
      ...(args.includes('--state-root') ? { stateRoot: option(args, '--state-root') } : {}),
    }
  }
  if (command === 'sync') return parseSyncArguments(args, usage)
  if (command === 'serve') {
    return {
      kind: 'serve',
      ...(args.includes('--parent-liveness-stdin') ? { parentLivenessFromStandardInput: true } : {}),
      stateDir: option(args, '--state-dir'),
    }
  }
  return usage()
}
