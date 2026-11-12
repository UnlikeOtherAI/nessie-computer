import { posix, win32 } from 'node:path'

import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CodingProcessControl } from './coding-session/process-control.js'
import { absoluteDirectory, resolveProgramPath, windowsPathExtensions } from './coding-session/program-path.js'
import type { CodingProcessIdentity } from './coding-session/types.js'
import { stopExecutorMcpProcessTree } from './mcp-command-process.js'
import type { ExecutorLocalMcpServer } from './mcp-servers.js'

/** What a local app's transport runs, and the containment what it starts is born into. */
export type LocalAppLaunch = {
  command: string
  args: string[]
  containment?: CodingProcessIdentity['containment']
}

/**
 * Where a local app starts. With the job helper (packaged Windows) it starts
 * inside its own Job Object, as coding agents do, so a stop can be proved and
 * its admission released (`mcp-session-manager.ts`); the program is resolved
 * first through `PATH` and `PATHEXT` to an absolute path, as the shell the
 * launch spec was written for would, because the helper's `CreateProcessW`
 * appends only `.exe`. `undefined` when no `PATH` entry holds it. Everywhere
 * else it starts as the launch spec names it.
 */
export const localAppLaunch = async (
  spec: ExecutorLocalMcpServer, control: Pick<CodingProcessControl, 'containedLaunch' | 'containment'>,
  platform: NodeJS.Platform = process.platform,
): Promise<LocalAppLaunch | undefined> => {
  const [program = '', ...args] = spec.command
  if (!control.containedLaunch) return { command: program, args }
  const env = { ...getDefaultEnvironment(), ...spec.env }
  const path = platform === 'win32' ? win32 : posix
  // A name with a directory in it is the launch spec's own, from its folder.
  const relative = /[\\/]/u.test(program) && !absoluteDirectory(program, platform)
  const fromFolder = spec.cwd && absoluteDirectory(spec.cwd, platform) ? path.resolve(spec.cwd, program) : undefined
  const resolved = relative ? fromFolder
    : await resolveProgramPath(program, env, platform, windowsPathExtensions(env))
  if (!resolved) return undefined
  return { ...control.containedLaunch(resolved, args), containment: control.containment }
}

/** Record the stdio child at transport start, before waiting for its MCP handshake. */
export class GuardedStdioTransport extends StdioClientTransport {
  processIdentity?: CodingProcessIdentity
  /** Whether a process was asked for at all: a transport never started started nothing. */
  launched = false
  /** The start, spawn and identity reads included, once it was asked for. */
  starting?: Promise<void>

  constructor(
    params: ConstructorParameters<typeof StdioClientTransport>[0],
    private readonly control: CodingProcessControl,
    private readonly containment?: CodingProcessIdentity['containment'],
  ) { super(params) }

  override start(): Promise<void> {
    this.launched = true
    this.starting = this.record()
    return this.starting
  }

  private async record(): Promise<void> {
    await super.start()
    const pid = this.pid
    if (pid === null || pid === undefined) return
    const contained = this.containment ? { containment: this.containment } : {}
    // Keep pid-only evidence if the process exits before its generation can be read.
    this.processIdentity = { pid, ...contained }
    const identified = await this.control.identify(pid)
    if (identified) this.processIdentity = { ...identified, ...contained }
  }
}

/**
 * Ends the Job Object a contained local app started in (packaged Windows), on
 * every path out of one: a start that failed, timed out or threw, a crash, an
 * idle or a stopping close. Everywhere else the transport's own close ends the
 * process, and a session bridge's detached hosts are meant to outlive it.
 */
export const stopLocalApp = async (
  transport: GuardedStdioTransport | undefined, control: CodingProcessControl,
): Promise<void> => {
  await transport?.starting?.catch(() => undefined)
  if (!transport?.launched) return
  await stopExecutorMcpProcessTree(transport, control, transport.processIdentity).catch(() => undefined)
}
