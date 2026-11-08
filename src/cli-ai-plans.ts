import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { PersonalChatgptConsoleStatusSchema, type PersonalChatgptProfileStatus } from '@nessie/executor-protocol'

import { addPlanConnection } from './cli-ai-plan-connection.js'
import { acceptOnly, onOff, operands } from './cli-options.js'
import { CliRefusal, CliUsageError, columns, printJson } from './cli-output.js'
import type { LabelledTeam } from './cli-teams.js'
import type { CliRun } from './cli-user.js'
import { executorChildCommand } from './executor-child-command.js'

/**
 * `ai plans`: ChatGPT plans on the AI tab. Each command runs the plumbing verb
 * the apps run, `personal-chatgpt-local --operation-stdin`, as a child: a
 * sign-in keeps its credential process under that verb's supervision, and no
 * OAuth URL, code or token ever passes through this command.
 *
 * On Windows a plan is kept by the background service, never under a copy of
 * this account's key, so the verb names the service's connection for the
 * team (`--service-executor`), as the Windows app does: the team itself when
 * the service runs it, otherwise the team's ChatGPT plan connection, which
 * `ai plans add` connects first when the team has none yet.
 */

/** Where a team's plans are kept: its own state folder, or a connection the Windows service runs. */
type PlanHolder = ['--state-dir', string] | ['--service-executor', string]

const holderOf = (team: LabelledTeam, platform: NodeJS.Platform): PlanHolder | null => {
  if (team.route === 'service') return ['--service-executor', team.executorId]
  if (team.planConnectionId) return ['--service-executor', team.planConnectionId]
  return platform === 'win32' ? null : ['--state-dir', team.stateDir]
}

type PlanStatus = ReturnType<typeof PersonalChatgptConsoleStatusSchema.parse>

const RESTRICTION = 'While a ChatGPT plan is signed in, agents can\'t open terminals or coding tools under your account. '
  + 'Sign out to get them back.'

const PHASES: Record<PersonalChatgptProfileStatus['phase'], string> = {
  unavailable: 'Sign-in unavailable', disconnected: 'Not signed in', signing_in: 'Finish signing in in your browser',
  identity_only: 'Signed in without permission to use this plan', ready: 'Signed in. Funds your own agents',
  reconnecting: 'Sign in again', disconnecting: 'Signing out',
}

const UNAVAILABLE: Record<string, string> = {
  host_sessions_active: 'Stop terminal, coding and local app sessions on this account before signing in.',
  native_context_unsupported: 'This installation can\'t yet prove supported credential protection.',
  deployment_ineligible: 'ChatGPT plans are unavailable on this Nessie server.',
  owner_authority_unavailable: 'Connect the team again with your own Nessie account.',
}
const UNAVAILABLE_OTHER = 'ChatGPT plans are unavailable for this team. Check your server connection and update Nessie Computer.'

/** Runs one operation through the plumbing verb, passing each status it publishes to `seen`. */
const operate = (
  holder: PlanHolder, operation: Record<string, unknown>, seen: (status: PlanStatus) => void,
): Promise<PlanStatus> => {
  const [command, ...args] = executorChildCommand({ execPath: process.execPath, execArgv: process.execArgv,
    entry: process.argv[1]!, packaged: process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1' },
  ['personal-chatgpt-local', '--operation-stdin', ...holder])
  return new Promise((resolve, reject) => {
    const child = spawn(command!, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let buffered = ''
    let errors = ''
    let last: PlanStatus | undefined
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buffered += chunk
      for (let newline = buffered.indexOf('\n'); newline >= 0; newline = buffered.indexOf('\n')) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        if (!line) continue
        try {
          last = PersonalChatgptConsoleStatusSchema.parse(JSON.parse(line))
          seen(last)
        } catch { /* Only status lines are published on this channel. */ }
      }
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { errors = `${errors}${chunk}`.slice(-2_000) })
    child.once('error', reject)
    child.once('close', (code) => {
      if (last) resolve(last)
      else reject(new CliRefusal('CHATGPT_PLAN_FAILED', errors.trim().split('\n').at(-1) || `The ChatGPT plan command stopped (${code}).`))
    })
    child.stdin.end(JSON.stringify(operation))
  })
}

const planName = (plan: PersonalChatgptProfileStatus, index: number): string => plan.label ?? `ChatGPT plan ${index + 1}`

const findPlan = (plans: readonly PersonalChatgptProfileStatus[], query: string): PersonalChatgptProfileStatus => {
  const wanted = query.trim().toLowerCase()
  const named = (plan: PersonalChatgptProfileStatus, index: number) => planName(plan, index).toLowerCase()
  const exact = plans.filter((plan, index) => plan.profileId === wanted || named(plan, index) === wanted)
  const matches = exact.length ? exact : plans.filter((plan, index) => named(plan, index).includes(wanted)
    || (wanted.length >= 4 && plan.profileId.startsWith(wanted)))
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) throw new CliUsageError(`"${query}" matches more than one plan.`, 'ai plans')
  throw new CliRefusal('CHATGPT_PLAN_NOT_FOUND', `No ChatGPT plan called "${query}".`)
}

const describe = (status: PlanStatus): string => {
  const rows = status.profiles.map((plan, index) => [planName(plan, index), PHASES[plan.phase],
    plan.backgroundConsentRevision ? 'background work allowed' : ''])
  return [
    ...(rows.length ? [columns(rows, '  ')] : ['No ChatGPT plans yet. Add one with nessie-computer ai plans add.']),
    ...(status.reason ? [UNAVAILABLE[status.reason] ?? UNAVAILABLE_OTHER] : []),
  ].join('\n')
}

const confirmRestriction = async (run: CliRun): Promise<void> => {
  if (run.options.flags.has('--yes')) return
  if (!run.context.interactive) throw new CliUsageError(`${RESTRICTION} Add --yes to go ahead.`, 'ai plans')
  const answer = await run.context.ask(`${RESTRICTION}\nType yes to continue: `)
  if (answer.trim().toLowerCase() !== 'yes') throw new CliRefusal('NOT_CONFIRMED', 'Nothing was changed.')
}

export const runAiPlans = async (run: CliRun): Promise<void> => {
  const [action = 'list', ...rest] = operands(run.options, 2, 3, 'ai plans')
  acceptOnly(run.options, 'ai plans', action === 'add' || action === 'sign-in' ? ['--yes'] : [])
  const team = await run.team()
  const quiet = () => undefined
  let holder = holderOf(team, run.context.platform)
  if (!holder && action === 'list') {
    if (run.options.json) printJson(run.context, { profiles: [] })
    else run.context.out(`ChatGPT plans for ${team.label}:\nNo ChatGPT plans yet. Add one with nessie-computer ai plans add.\n`)
    return
  }
  if (!holder && action !== 'add') {
    throw new CliRefusal('CHATGPT_PLAN_NOT_FOUND', `${team.label} has no ChatGPT plans yet. Add one with nessie-computer ai plans add.`)
  }
  // Asked once, before anything is connected or signed in.
  const confirmed = !holder && action === 'add'
  if (confirmed) await confirmRestriction(run)
  holder ??= ['--service-executor', await addPlanConnection(run, team)]
  const current = await operate(holder, { operation: 'status' }, quiet)
  const plan = () => {
    if (!rest[0]) throw new CliUsageError(`Name the plan: nessie-computer ai plans ${action} <plan>.`, 'ai plans')
    return findPlan(current.profiles, rest[0])
  }
  let operation: Record<string, unknown> | undefined
  if (action === 'list') {
    if (rest.length) throw new CliUsageError('ai plans list takes nothing after it.', 'ai plans')
  } else if (action === 'add' || action === 'sign-in') {
    if (rest.length > 1) throw new CliUsageError(`Give one plan name, in quotes when it has spaces: ai plans ${action} "Work plan".`, 'ai plans')
    if (!confirmed) await confirmRestriction(run)
    operation = action === 'add'
      ? { operation: 'start', acknowledgeHostRestriction: true, newProfileId: randomUUID(),
        label: rest[0] ?? `ChatGPT plan ${current.profiles.length + 1}` }
      : { operation: 'start', acknowledgeHostRestriction: true, profileId: plan().profileId }
  } else if (action === 'rename') {
    if (rest.length !== 2) throw new CliUsageError('Use ai plans rename <plan> "<new name>".', 'ai plans')
    operation = { operation: 'rename', profileId: plan().profileId, label: rest[1] }
  } else if (action === 'background') {
    const chosen = plan()
    operation = { operation: 'background-consent', profileId: chosen.profileId,
      enabled: onOff(rest[1], 'ai plans background <plan>'), expectedRevision: chosen.backgroundConsentRevision }
  } else if (action === 'disconnect') {
    if (rest.length !== 1) throw new CliUsageError('Use ai plans disconnect <plan>.', 'ai plans')
    operation = { operation: 'disconnect', profileId: plan().profileId }
  } else throw new CliUsageError(`ai plans has no "${action}". See nessie-computer help ai plans.`, 'ai plans')
  let printed = false
  const status = operation ? await operate(holder, operation, (published) => {
    if (run.options.json || printed || !published.profiles.some((entry) => entry.phase === 'signing_in')) return
    printed = true
    run.context.out('Finish signing in in your browser. Keep this command running until it says you are signed in.\n')
  }) : current
  if (status.reason && operation) {
    throw new CliRefusal(`CHATGPT_${status.reason.toUpperCase()}`, UNAVAILABLE[status.reason] ?? UNAVAILABLE_OTHER)
  }
  if (run.options.json) printJson(run.context, status)
  else run.context.out(`ChatGPT plans for ${team.label}:\n${describe(status)}\n`)
}
