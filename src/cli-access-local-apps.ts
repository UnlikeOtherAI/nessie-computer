import type { TeamDescription } from './cli-describe.js'
import { acceptOnly, onOff, operands } from './cli-options.js'
import { CliRefusal, CliUsageError, columns, listed, printJson } from './cli-output.js'
import type { CliRun } from './cli-user.js'
import { type LocalMcpPolicy } from './mcp-policy.js'

/**
 * `access local-apps`: the Local apps section. A discovered app is switched
 * on or off through `mcpPolicy.disabled`; an app the owner added is removed by
 * name (`mcpServerRemovals`), exactly as the window does it.
 */

const SOURCE_WORDS: Record<string, string> = {
  unlikeotherai: 'From UnlikeOtherAI', 'claude-code': 'From your Claude Code setup', codex: 'From your Codex setup',
  configured: 'Added by you',
}

/** "all installed (kelpie)", "kelpie and figma", "none" — for `access show`. */
export const localAppsSummary = (description: TeamDescription): string => {
  const on = description.localApps.filter((app) => app.enabled).map((app) => app.name)
  return description.mcpPolicy.mode === 'installed' && description.mcpPolicy.disabled.length === 0
    ? `all installed (${listed(on)})` : listed(on)
}

const appRows = (description: TeamDescription): string[][] => description.localApps.map((app) => [
  app.name, app.enabled ? 'on' : 'off',
  `${SOURCE_WORDS[app.source] ?? 'Found on this computer'}${app.installed ? '' : ' · Not installed any more'}`,
])

const LISTED_ONLY = 'This team uses only the local apps you added. Run nessie-computer access local-apps all on '
  + 'to use every installed app, then switch off the ones you don\'t want.'

const nextPolicy = (description: TeamDescription, action: string, name: string | undefined): LocalMcpPolicy => {
  const policy = description.mcpPolicy
  if (action === 'all') {
    if (onOff(name, 'access local-apps all')) return { mode: 'installed', disabled: [] }
    const found = description.localApps.filter((app) => app.source !== 'configured').map((app) => app.name)
    return { mode: 'installed', disabled: [...new Set([...policy.disabled, ...found])].sort() }
  }
  if (name === undefined) throw new CliUsageError(`Name the app: nessie-computer access local-apps ${action} <name>.`, 'access local-apps')
  const app = description.localApps.find((entry) => entry.name === name)
  if (!app) throw new CliRefusal('LOCAL_APP_NOT_FOUND', `No local app called ${name} on this computer.`)
  if (app.source === 'configured') {
    throw new CliRefusal('LOCAL_APP_ADDED_BY_YOU', `You added ${name} yourself. Run nessie-computer access local-apps remove ${name} to take it away.`)
  }
  if (policy.mode === 'listed') throw new CliRefusal('LOCAL_APPS_LISTED_ONLY', LISTED_ONLY)
  const disabled = new Set(policy.disabled)
  if (action === 'on') disabled.delete(name)
  else disabled.add(name)
  return { ...policy, disabled: [...disabled].sort() }
}

export const runAccessLocalApps = async (run: CliRun): Promise<void> => {
  acceptOnly(run.options, 'access local-apps')
  const [action = 'list', name, extra] = operands(run.options, 2, 3, 'access local-apps')
  if (extra !== undefined) throw new CliUsageError('Name one local app at a time.', 'access local-apps')
  const team = await run.team()
  const ops = run.ops(team)
  const description = await ops.describe()
  if (action === 'list') {
    if (run.options.json) printJson(run.context, description.localApps)
    else run.context.out(description.localApps.length
      ? `Apps installed on this computer that agents in ${team.label} may use:\n${columns(appRows(description), '  ')}\n`
      : 'No local apps found on this computer.\n')
    return
  }
  if (action === 'remove') {
    const app = description.localApps.find((entry) => entry.name === name)
    if (name === undefined || !app || app.source !== 'configured') {
      throw new CliRefusal('LOCAL_APP_NOT_ADDED', `${name ?? 'That app'} isn't a local app you added. Switch a found app off instead.`)
    }
  }
  if (action !== 'remove' && action !== 'on' && action !== 'off' && action !== 'all') {
    throw new CliUsageError(`access local-apps has no "${action}". Use list, on, off, all or remove.`, 'access local-apps')
  }
  const after = await ops.save(action === 'remove' ? { mcpServerRemovals: [name!] }
    : { settings: { mcpPolicy: nextPolicy(description, action, name) } })
  if (run.options.json) printJson(run.context, after.localApps)
  else run.context.out(`Local apps on for ${team.label}: ${localAppsSummary(after)}.\n`)
}
