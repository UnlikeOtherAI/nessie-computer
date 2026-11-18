import { CliRefusal, CliTimeout } from './cli-output.js'
import { codeLines } from './cli-pairing-words.js'
import type { LabelledTeam } from './cli-teams.js'
import type { CliRun } from './cli-user.js'
import { ensureServiceAccess } from './windows-service-grant.js'
import { expectAnswer, serviceRequests } from './windows-service-control.js'

/**
 * The Windows ChatGPT plan connection, made as the Windows app makes it: a
 * ChatGPT plan's sign-in is held by the background service, so a team this
 * account runs gets a second connection to the same team, run by the
 * service. If Windows asks, approve account access. Enter the resulting code
 * under Computers → Add a computer.
 */

const POLL_MS = 3_000

type PairingView = { status?: string; code?: string; expiresAt?: string; executorId?: string }

const pairing = async (run: CliRun, request: Parameters<CliRun['service']>[0]): Promise<PairingView> => {
  const answer = await run.service(request)
  if (request.command === 'planPairingStart' && answer.status === 'error' && answer.reason === 'The control request is malformed.') {
    throw new CliRefusal('SERVICE_UPDATE_NEEDED', 'Update Nessie Computer. Its installed service does not support this plan connection.')
  }
  return (expectAnswer(answer, 'pairing').pairing ?? {}) as PairingView
}

/** Connects the service's plan connection for `team` and answers with its id. */
export const addPlanConnection = async (run: CliRun, team: LabelledTeam): Promise<string> => {
  const { context, options } = run
  if (!team.apiBaseUrl) throw new CliRefusal('TEAM_SERVER_UNKNOWN', `Nessie hasn't said which server ${team.label} uses yet. Try again shortly.`)
  if (!options.json) {
    context.out(`On Windows the Nessie Computer service keeps ChatGPT plans, so ${team.label} needs one more connection to it.\n`
      + 'If Windows asks for service access, approve it to get a code to enter in Nessie.\n')
  }
  await ensureServiceAccess(context.run)
  let view = await pairing(run, serviceRequests.planPairingStart(team.apiBaseUrl, team.executorId))
  if (view.status !== 'waiting') throw new CliRefusal('PAIRING_NOT_STARTED', 'Nessie didn\'t give a pairing code. Try again.')
  // With --json the plans are the one document on standard output; the code still has to reach the person.
  const tell = options.json ? context.err : context.out
  tell(`${codeLines(view.code, view.expiresAt, context.now())}Waiting for Nessie…\n`)
  while (view.status === 'waiting') {
    await context.sleep(POLL_MS)
    view = await pairing(run, serviceRequests.pairingStatus())
  }
  if (view.status === 'expired') {
    throw new CliTimeout('The code expired before it was entered. Run nessie-computer ai plans add for a new one.')
  }
  if (view.status !== 'paired' || !view.executorId) throw new CliRefusal('PAIRING_CANCELLED', 'Nessie didn\'t accept this computer.')
  if (!options.json) context.out(`The ChatGPT plan connection for ${team.label} is ready.\n`)
  return view.executorId
}
