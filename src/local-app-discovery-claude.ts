/**
 * A stdio MCP server as an owner's own tool configuration declares it, before
 * discovery has checked its name or found its program.
 */
export type DeclaredLocalApp = {
  name: string
  command: string[]
  cwd?: string
  env?: Record<string, string>
}

const record = (value: unknown): Record<string, unknown> | undefined => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
)

/**
 * The user-scope stdio servers in Claude Code's `~/.claude.json`
 * (`mcpServers`, what `claude mcp add --scope user` writes). A project's own
 * `.mcp.json` and the per-folder entries under `projects` belong to one
 * repository, not to the person, so they are not this computer's apps. An
 * entry whose `type` is `http` or `sse` is remote; an entry this cannot read
 * exactly is left out.
 */
export const claudeDeclaredLocalApps = (text: string): DeclaredLocalApp[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const servers = record(record(parsed)?.mcpServers)
  if (!servers) return []
  const declared: DeclaredLocalApp[] = []
  for (const [name, value] of Object.entries(servers)) {
    const entry = record(value)
    if (!entry || (entry.type !== undefined && entry.type !== 'stdio')) continue
    if (typeof entry.command !== 'string' || !entry.command) continue
    const args = entry.args === undefined ? [] : entry.args
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) continue
    const env = entry.env === undefined ? {} : record(entry.env)
    if (!env || Object.values(env).some((item) => typeof item !== 'string')) continue
    if (entry.cwd !== undefined && typeof entry.cwd !== 'string') continue
    declared.push({
      name,
      command: [entry.command, ...args as string[]],
      ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
      ...(Object.keys(env).length ? { env: env as Record<string, string> } : {}),
    })
  }
  return declared
}
