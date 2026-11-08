import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { PersonalChatgptConsoleStatusSchema, type PersonalChatgptProfileStatus } from '@nessie/executor-protocol'

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
 */

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
const operate = (team: LabelledTeam, operation: Record<string, unknown>, seen: (status: PlanStatus) => void): Promise<PlanStatus> => {
  const [command, ...args] = executorChildCommand({ execPath: process.execPath, execArgv: process.execArgv,
    entry: process.argv[1]!, packaged: process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1' },
  ['personal-chatgpt-local', '--operation-stdin', '--state-dir', team.stateDir])
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
  const exact = plans.filter((plan, index) => plan.profileId === wanted || planName(plan, index).toLowerCase() === wanted)
  const matches = exact.length ? exact : plans.filter((plan, index) => planName(plan, index).toLowerCase().includes(wanted)
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
  if (run.context.platform === 'win32') {
    throw new CliRefusal('CHATGPT_PLANS_IN_APP', 'On Windows, manage ChatGPT plans in the Nessie Computer app.')
  }
  const team = await run.team()
  const quiet = () => undefined
  const current = await operate(team, { operation: 'status' }, quiet)
  const plan = () => {
    if (!rest[0]) throw new CliUsageError(`Name the plan: nessie-computer ai plans ${action} <plan>.`, 'ai plans')
    return findPlan(current.profiles, rest[0])
  }
  let operation: Record<string, unknown> | undefined
  if (action === 'list') {
    if (rest.length) throw new CliUsageError('ai plans list takes nothing after it.', 'ai plans')
  } else if (action === 'add' || action === 'sign-in') {
    if (rest.length > 1) throw new CliUsageError(`Give one plan name, in quotes when it has spaces: ai plans ${action} "Work plan".`, 'ai plans')
    await confirmRestriction(run)
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
  const status = operation ? await operate(team, operation, (published) => {
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
