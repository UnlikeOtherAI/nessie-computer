import { createHash } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { canonicalExecutorJson, EXECUTOR_MCP_TOOL_MAXIMUM, type ExecutorMcpTool, type ExecutorMcpToolCatalog } from '@nessie/executor-protocol'
import type { ExecutorMcpFailure } from './mcp-session-manager.js'

export const PROBE_YIELDED = Symbol('probe yielded')
export type SessionCatalog = {
  content: { server: string; serverVersion?: string; tools: ExecutorMcpTool[] }
  digest: string
}
type McpCatalogSession = { client: Client; catalog?: SessionCatalog }
const failure = (code: string, message: string): ExecutorMcpFailure => ({ code, message, success: false })
const unavailable = (message: string): ExecutorMcpFailure => failure('EXECUTOR_MCP_UNAVAILABLE', message)

export const loadExecutorMcpCatalog = async (
    session: McpCatalogSession,
    server: string,
    callTimeoutMs: number,
    log: (message: string, cause: unknown) => void,
    yieldTo?: AbortSignal,
  ): Promise<SessionCatalog | ExecutorMcpFailure | typeof PROBE_YIELDED> => {
    if (session.catalog) return session.catalog
    const tools: ExecutorMcpTool[] = []
    let cursor: string | undefined
    // The daemon walks the server's own pagination so the digest below covers
    // the whole catalog and stays identical across the pages it then serves.
    // The walk has one deadline, not one per page: the command's expiry holds
    // one call's worth of time for it (`@nessie/executor-protocol` executor-timing.ts),
    // and a server that split its catalog into many slow pages used to spend
    // a call timeout on each and outlive the command.
    const deadline = Date.now() + callTimeoutMs
    do {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        return unavailable(`The MCP server "${server}" did not finish tools/list in time.`)
      }
      let page
      try {
        page = await session.client.listTools(
          cursor === undefined ? undefined : { cursor },
          { timeout: remaining, ...(yieldTo === undefined ? {} : { signal: yieldTo }) },
        )
      } catch (error) {
        if (yieldTo?.aborted) return PROBE_YIELDED
        log(`local MCP server "${server}" refused tools/list`, error)
        return unavailable(`The MCP server "${server}" did not answer tools/list.`)
      }
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          inputSchema: tool.inputSchema as Record<string, unknown>,
        })
      }
      if (tools.length > EXECUTOR_MCP_TOOL_MAXIMUM) {
        return failure(
          'EXECUTOR_MCP_CATALOG_TOO_LARGE',
          `The MCP server "${server}" offers more than ${EXECUTOR_MCP_TOOL_MAXIMUM} tools.`,
        )
      }
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined
    } while (cursor !== undefined)
    const serverVersion = session.client.getServerVersion()?.version
    const content: SessionCatalog['content'] = {
      server,
      ...(serverVersion === undefined ? {} : { serverVersion }),
      tools,
    }
    const catalog: SessionCatalog = {
      content,
      digest: `sha256:${createHash('sha256').update(canonicalExecutorJson(content)).digest('hex')}`,
    }
    session.catalog = catalog
    return catalog
  }

  /**
   * One page of the full catalog, sized so the result document fits the
   * terminal-result budget; `cursor` is the opaque offset a previous page
   * returned. The digest never changes between pages of one catalog.
   */
export const executorMcpCatalogPage = (
    catalog: SessionCatalog,
    cursor: string | undefined,
    maxResultBytes: number,
  ): Record<string, unknown> => {
    const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > catalog.content.tools.length) {
      return failure('EXECUTOR_MCP_CURSOR_INVALID', 'The catalog cursor does not name a page.')
    }
    // The 1 KiB reserve covers the success flag, the catalog envelope and the
    // cursor inside the terminal-result budget.
    const budget = Math.max(1_024, maxResultBytes - 1_024)
    const fixed = Buffer.byteLength(JSON.stringify({
      server: catalog.content.server,
      serverVersion: catalog.content.serverVersion,
      digest: catalog.digest,
    }))
    let used = fixed
    const tools: ExecutorMcpTool[] = []
    for (const tool of catalog.content.tools.slice(offset)) {
      const size = Buffer.byteLength(JSON.stringify(tool)) + 1
      if (tools.length > 0 && used + size > budget) break
      used += size
      tools.push(tool)
    }
    const nextOffset = offset + tools.length
    const document: ExecutorMcpToolCatalog = {
      ...catalog.content,
      tools,
      digest: catalog.digest,
      ...(nextOffset < catalog.content.tools.length ? { nextCursor: String(nextOffset) } : {}),
    }
    return { catalog: document, success: true }
  }
