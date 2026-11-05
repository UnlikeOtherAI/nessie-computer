import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CodingProcessControl } from './coding-session/process-control.js'
import type { CodingProcessIdentity } from './coding-session/types.js'
import type { PersonalHostExecutionLease } from './personal-inference-guard.js'

/** Record the stdio child at transport start, before waiting for its MCP handshake. */
export class GuardedStdioTransport extends StdioClientTransport {
  processIdentity?: CodingProcessIdentity
  constructor(
    params: ConstructorParameters<typeof StdioClientTransport>[0],
    private readonly control: CodingProcessControl,
    private readonly lease: PersonalHostExecutionLease | null,
  ) { super(params) }

  override async start(): Promise<void> {
    await super.start()
    const pid = this.pid
    if (pid === null || pid === undefined) return
    // Keep pid-only evidence if the process exits before its generation can be read.
    const pendingIdentity = { pid }
    this.processIdentity = pendingIdentity
    await this.lease?.bindExecution(pendingIdentity)
    const identified = await this.control.identify(pid)
    if (identified) {
      this.processIdentity = identified
      await this.lease?.bindExecution(identified)
    }
  }
}
