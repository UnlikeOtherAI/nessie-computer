import { resolve } from 'node:path'

import { setExistingSessionsEnabled } from './existing-session/settings.js'
import { configuredAllowedOrigins } from './configuration-input.js'
import { describeTeamAt, saveAccess, type TeamDescription } from './cli-describe.js'
import { acceptOnly, onOff, operands } from './cli-options.js'
import { CliRefusal, CliUsageError, columns, listed, printJson } from './cli-output.js'
import { programRuleSummary } from './cli-access-programs.js'
import { localAppsSummary } from './cli-access-local-apps.js'
import type { LabelledTeam } from './cli-teams.js'
import type { CliRun } from './cli-user.js'
import { deriveExecutorWorkspaceFolderName } from './workspace-folders.js'

/** The Access tab: `access show`, `folders`, `websites` and `coding-assistants`. */

const describe = (team: LabelledTeam): Promise<TeamDescription> => describeTeamAt(team.stateDir)

const CODING_ON = 'can read and message Claude Code and Codex conversations'
const CODING_OFF = 'can\'t read your Claude Code and Codex conversations'

const show = async (run: CliRun): Promise<void> => {
  acceptOnly(run.options, 'access show')
  operands(run.options, 2, 0, 'access show')
  const team = await run.team()
  const description = await describe(team)
  if (run.options.json) {
    printJson(run.context, description)
    return
  }
  run.context.out(`${team.label} can use:\n${columns([
    ['Folders', listed(description.reach.folders.map((folder) => `${folder.name} (${folder.path})`))],
    ['Programs', programRuleSummary(description.commandPolicy)],
    ['Websites', listed(description.reach.allowedOrigins)],
    ['Local apps', localAppsSummary(description)],
    ['Coding assistants', description.existingCodingSessionsEnabled ? CODING_ON : CODING_OFF],
  ], '  ')}\n`)
}

const folders = async (run: CliRun): Promise<void> => {
  const [action = 'list', target] = operands(run.options, 2, 2, 'access folders')
  acceptOnly(run.options, 'access folders', action === 'add' ? ['--name'] : [])
  const team = await run.team()
  const current = team.state.workspaceFolders
  if (action === 'list') {
    if (target !== undefined) throw new CliUsageError('access folders list takes no folder.', 'access folders')
    if (run.options.json) printJson(run.context, current.map(({ name, path }) => ({ name, path })))
    else run.context.out(`Agents in ${team.label} can read these folders and prepare changes for you to approve:\n${
      columns(current.map((folder) => [folder.name, folder.path]), '  ')}\n`)
    return
  }
  if (target === undefined) throw new CliUsageError(`Name the folder: nessie-computer access folders ${action} <path>.`, 'access folders')
  let next = current
  if (action === 'add') {
    const path = resolve(target)
    const name = run.options.values.get('--name') ?? deriveExecutorWorkspaceFolderName(path)
    if (current.some((folder) => folder.name === name)) {
      throw new CliRefusal('FOLDER_NAME_TAKEN', `${team.label} already has a folder called ${name}. Choose another with --name.`)
    }
    next = [...current, { name, path }]
  } else if (action === 'remove') {
    next = current.filter((folder) => folder.name !== target && folder.path !== resolve(target))
    if (next.length === current.length) throw new CliRefusal('FOLDER_NOT_FOUND', `${team.label} has no folder ${target}.`)
    if (next.length === 0) {
      throw new CliRefusal('LAST_FOLDER', 'Keep at least one folder. To end this team\'s access, disconnect it.')
    }
  } else throw new CliUsageError(`access folders has no "${action}". Use list, add or remove.`, 'access folders')
  const saved = await saveAccess(team.stateDir, { workspaceFolders: next })
  if (run.options.json) printJson(run.context, saved.workspaceFolders.map(({ name, path }) => ({ name, path })))
  else {
    run.context.out(`${action === 'add' ? 'Added' : 'Removed'} ${target}. Folders shared with ${team.label}: ${
      listed(saved.workspaceFolders.map((folder) => folder.name))}.\n`)
    if (saved.workspaceFolders.length > 1 && current.length === 1) {
      run.context.out('Agents\' browser, sandboxed commands and coding sessions here need exactly one folder.\n')
    }
  }
}

/** An https address as the origin the browser gateway stores, or a usage error. */
const websiteOrigin = (value: string): string => {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') throw new Error('not https')
    return configuredAllowedOrigins([url.origin])[0]!
  } catch {
    throw new CliUsageError('Use an https address such as https://example.com.', 'access websites')
  }
}

const websites = async (run: CliRun): Promise<void> => {
  acceptOnly(run.options, 'access websites')
  const [action = 'list', target] = operands(run.options, 2, 2, 'access websites')
  const team = await run.team()
  const current = (await describe(team)).reach.allowedOrigins
  if (action === 'list') {
    if (run.options.json) printJson(run.context, current)
    else run.context.out(current.length ? `Agents in ${team.label} may open these websites in the agent browser:\n${
      current.map((site) => `  ${site}`).join('\n')}\n` : `No websites yet. Agents in ${team.label} can't browse from this computer.\n`)
    return
  }
  if (target === undefined) throw new CliUsageError(`Name the website: nessie-computer access websites ${action} <https://site>.`,
    'access websites')
  if (action !== 'add' && action !== 'remove') {
    throw new CliUsageError(`access websites has no "${action}". Use list, add or remove.`, 'access websites')
  }
  const site = websiteOrigin(target)
  if (action === 'add' && current.includes(site)) throw new CliRefusal('WEBSITE_LISTED', `${site} is already listed.`)
  if (action === 'remove' && !current.includes(site)) throw new CliRefusal('WEBSITE_NOT_FOUND', `${team.label} has no website ${site}.`)
  const next = action === 'add' ? [...current, site] : current.filter((entry) => entry !== site)
  await saveAccess(team.stateDir, { settings: { allowedOrigins: next } })
  const after = (await describe(team))
  if (run.options.json) printJson(run.context, after.reach.allowedOrigins)
  else {
    run.context.out(`${action === 'add' ? 'Added' : 'Removed'} ${site}. Websites allowed: ${listed(after.reach.allowedOrigins)}.\n`)
    if (!after.sandbox.browserConfigured) {
      run.context.out('The agent browser isn\'t set up on this computer yet. These websites apply once it is.\n')
    }
  }
}

const RECIPE_COMMAND = 'claude --mcp-config nessie-channel.json --dangerously-load-development-channels server:nessie'

const codingAssistants = async (run: CliRun): Promise<void> => {
  acceptOnly(run.options, 'access coding-assistants')
  const [action = 'show', value] = operands(run.options, 2, 2, 'access coding-assistants')
  const team = await run.team()
  if (action === 'conversations') {
    const enabled = onOff(value, 'access coding-assistants conversations')
    await setExistingSessionsEnabled(team.stateDir, enabled)
    if (run.options.json) printJson(run.context, { existingCodingSessionsEnabled: enabled })
    else run.context.out(`Agents in ${team.label} ${enabled ? CODING_ON : CODING_OFF}.${
      enabled ? '' : ' Your conversations keep running.'}\n`)
    return
  }
  if (value !== undefined) throw new CliUsageError(`access coding-assistants ${action} takes nothing after it.`, 'access coding-assistants')
  const description = await describe(team)
  if (action === 'show') {
    if (run.options.json) printJson(run.context, { existingCodingSessionsEnabled: description.existingCodingSessionsEnabled })
    else run.context.out(`Agents in ${team.label} ${description.existingCodingSessionsEnabled ? CODING_ON : CODING_OFF}.\n`)
    return
  }
  if (action !== 'claude-setup') {
    throw new CliUsageError(`access coding-assistants has no "${action}". Use show, conversations or claude-setup.`,
      'access coding-assistants')
  }
  const configuration = description.existingClaudeChannelConfiguration
  if (!configuration) throw new CliRefusal('CODING_SESSIONS_UNAVAILABLE', `Resume ${team.label} to set up Claude Code.`)
  if (run.options.json) {
    printJson(run.context, { configuration, command: RECIPE_COMMAND })
    return
  }
  run.context.out(['Let Claude Code receive messages from Nessie:', '',
    '1. Create nessie-channel.json in your working folder and paste this into it:', '',
    JSON.stringify(configuration, undefined, 2), '', '2. Open a terminal in that folder and run:', '',
    `   ${RECIPE_COMMAND}`, '', 'Claude Code still asks for your permission as usual.'].join('\n') + '\n')
}

export const ACCESS: Record<string, (run: CliRun) => Promise<void>> = {
  'access show': show,
  'access folders': folders,
  'access websites': websites,
  'access coding-assistants': codingAssistants,
}
