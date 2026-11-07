import { secureApiUrl } from './pairing-origin.js'
import { parseExecutorWorkspaceFolderArguments, workspaceFoldersFromInput,
  type ExecutorWorkspaceFolder } from './workspace-folder-arguments.js'
import { parseExecutorMcpServerArguments } from './mcp-server-arguments.js'
import type { ExecutorLocalMcpServer } from './mcp-servers.js'

/** Structural CLI grammar and bounded stdin pairing inputs, independent of runtime custody. */
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
  | { kind: 'serve-direct-local-inference' }
  | { kind: 'describe'; stateDir: string }
  | { kind: 'deeptest-source'; sourceGrantFile: string }
  | { executionGrantFile: string; kind: 'deeptest-execution' }
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
  | { assumeYes: boolean; executorId: string; kind: 'enable'; stateDir?: string }
  | { executorId: string; kind: 'disable' }
  | { executorId?: string; kind: 'status'; stateRoot?: string }

const usage = (): never => {
  throw new Error(
    'Usage: nessie-executor login --api <nessie|deeptest|https://your-nessie.example> [--workspace <folder>] '
    + '[--operations file.list,file.read]\n'
    + '       nessie-executor teams [--json] [--state-root <path>]\n'
    + '       nessie-executor unpair (--executor <uuid>|--state-dir <owner-only-path>) [--json]\n'
    + '       nessie-executor daemon --executor <uuid>\n'
    + '       nessie-executor permissions --executor <uuid> [--existing-sessions on|off] [--allow-all|--allow "git *,pnpm *"] '
    + '[--deny "git push *"|--clear-deny]\n'
    + '       nessie-executor pairing-start --api <nessie|deeptest|https://your-nessie.example> '
    + '[--cli] [--state-dir <owner-only-path>] [--replace --executor <uuid>]\n'
    + '       nessie-executor pair --api <nessie|deeptest|https://your-nessie.example> --enrollment <uuid> '
    + '(--challenge <token>|--challenge-stdin) --state-dir <owner-only-path> '
    + '(--workspace <absolute-read-only-root>'
    + '|--folder <name>=<absolute-read-only-root> [--folder ...])\n'
    + '       nessie-executor pair --api <nessie|deeptest|https://your-nessie.example> --enrollment <uuid> '
    + '--pair-input-stdin --state-dir <owner-only-path>\n'
    + '       nessie-executor configure --state-dir <owner-only-path> '
    + '--operations <file.list,file.read,file.write,command.run,browser.open,browser.observe,'
    + 'browser.act,coding.launch,coding.observe,workspace.review,workspace.promote,sandbox.stop,'
    + 'mcp.tools,mcp.call> '
    + '[--native-helper </absolute/owner-only/nessie-executor-native>] '
    + '[--workspace <absolute-read-only-root>'
    + '|--folder <name>=<absolute-read-only-root> [--folder ...]] '
    + '[--tools <program,program,...>|--clear-tools] '
    + '[--mcp-server <name>=<command and arguments> [--mcp-server ...]|--clear-mcp-servers]\n'
    + '       nessie-executor configure --configuration-input-stdin '
    + '--state-dir <owner-only-path>\n'
    + '       nessie-executor configure-browser --state-dir <owner-only-path> '
    + '--allowed-origins <https://origin.example,...> --guest-initrd-builder <absolute-owner-only-file> '
    + '--kernel <absolute-owner-only-file> --vm-helper <absolute-owner-only-file> '
    + '--runtime-bundle <absolute-owner-only-directory>\n'
    + '       nessie-executor configure-codex --state-dir <owner-only-path> '
    + '--auth-profile <absolute-owner-only-auth.json> --guest-initrd-builder <absolute-owner-only-file> '
    + '--kernel <absolute-owner-only-file> --vm-helper <absolute-owner-only-file> '
    + '--runtime-bundle <absolute-owner-only-directory>\n'
    + '       nessie-executor connect|heartbeat|serve --state-dir <owner-only-path>\n'
    + '       nessie-executor serve-ollama-search-mcp\n'
    + '       nessie-executor serve-coding-session-mcp --config <absolute-owner-only-file>\n'
    + '       nessie-executor serve-session-secrets --session-dir <absolute-session-directory>\n'
    + '       nessie-executor coding-session-host --config <absolute-owner-only-file> --session <uuid>\n'
    + '       nessie-executor serve-direct-local-inference --config-stdin\n'
    + '       nessie-executor local-inference endpoint configure|status|remove --state-dir <path> [--config-stdin]\n'
    + '       nessie-executor describe --state-dir <owner-only-path>\n'
    + '       nessie-executor deeptest-source --source-grant-file <absolute-owner-only-file>\n'
    + '       nessie-executor deeptest-execution --execution-grant-file <absolute-owner-only-file>\n'
    + '       nessie-executor publish-deeptest-source-grant --state-dir <owner-only-path>\n'
    + '       nessie-executor publish-deeptest-execution-grant --state-dir <owner-only-path> --confirm-active-testing\n'
    + '       nessie-executor revoke-deeptest-execution-grant --state-dir <owner-only-path>\n'
    + '       nessie-executor native-browser-cookie-import --state-root <owner-only-path> '
    + '--extension-origin <chrome-extension://release-id/> --caller-origin <chrome-extension://release-id/>\n'
    + '       nessie-executor enable <executorId> [--state-dir <owner-only-path>] [--yes]\n'
    + '       nessie-executor disable <executorId>\n'
    + '       nessie-executor autorestart <executorId> [on|off]\n'
    + '       nessie-executor status [<executorId>] [--state-root <owner-only-path>]',
  )
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

type PairingChallenge = Pick<Extract<ParsedCommand, { kind: 'pair' }>, 'challenge' | 'challengeFromStandardInput'>
const pairingChallenge = (args: string[]): PairingChallenge => {
  const standardInput = args.includes('--challenge-stdin')
  const commandLine = args.includes('--challenge')
  if (standardInput === commandLine) return usage()
  return standardInput ? { challengeFromStandardInput: true } : { challenge: option(args, '--challenge') }
}

export const readPairingChallenge = async (): Promise<string> => {
  const chunks: Buffer[] = []
  let byteLength = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += bytes.byteLength
    if (byteLength > 8_192) throw new Error('Pairing challenge is too large.')
    chunks.push(bytes)
  }
  const challenge = Buffer.concat(chunks).toString('utf8').trim()
  if (!challenge) throw new Error('Pairing challenge is required on standard input.')
  return challenge
}

export const readPairingInput = async (): Promise<{
  challenge: string
  workspaceFolders: ExecutorWorkspaceFolder[]
}> => {
  const chunks: Buffer[] = []
  let byteLength = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += bytes.byteLength
    if (byteLength > 12_288) throw new Error('Pairing input is too large.')
    chunks.push(bytes)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('Pairing input on standard input is malformed.')
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || typeof (parsed as { challenge?: unknown }).challenge !== 'string'
    || !(parsed as { challenge: string }).challenge
  ) {
    throw new Error('Pairing input on standard input is malformed.')
  }
  return {
    challenge: (parsed as { challenge: string }).challenge,
    workspaceFolders: workspaceFoldersFromInput(parsed, 'Pairing input on standard input'),
  }
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
  if (command === 'serve') {
    return {
      kind: 'serve',
      ...(args.includes('--parent-liveness-stdin') ? { parentLivenessFromStandardInput: true } : {}),
      stateDir: option(args, '--state-dir'),
    }
  }
  return usage()
}
