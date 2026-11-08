import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { CliRefusal, CliTimeout } from './cli-output.js'
import type { LabelledTeam } from './cli-teams.js'
import type { CliRun } from './cli-user.js'
import { grantServiceFolder } from './windows-service-grant.js'
import { expectAnswer, serviceRequests } from './windows-service-control.js'

/**
 * The Windows ChatGPT plan connection, made as the Windows app makes it: a
 * ChatGPT plan's sign-in is held by the background service, so a team this
 * account runs gets a second connection to the same team, run by the
 * service. Windows asks once (UAC) to let the service read the `Nessie`
 * folder; then Nessie shows one more pairing code, entered under Computers →
 * Add a computer like any other.
 */

const POLL_MS = 3_000

type PairingView = { status?: string; code?: string; expiresAt?: string; executorId?: string }

const codeText = (code: string | undefined): string => (code ? `${code.slice(0, 4)} ${code.slice(4)}` : '')

const pairing = async (run: CliRun, request: Parameters<CliRun['service']>[0]): Promise<PairingView> => (
  (expectAnswer(await run.service(request), 'pairing').pairing ?? {}) as PairingView)

/** Connects the service's plan connection for `team` and answers with its id. */
export const addPlanConnection = async (run: CliRun, team: LabelledTeam): Promise<string> => {
  const { context, options } = run
  if (!team.apiBaseUrl) throw new CliRefusal('TEAM_SERVER_UNKNOWN', `Nessie hasn't said which server ${team.label} uses yet. Try again shortly.`)
  if (!options.json) {
    context.out(`On Windows the Nessie Computer service keeps ChatGPT plans, so ${team.label} needs one more connection to it.\n`
      + 'Windows asks you to allow it, then Nessie shows one more pairing code.\n')
  }
  const workspace = join(context.home, 'Nessie')
  await mkdir(workspace, { recursive: true })
  await grantServiceFolder(context.run, workspace)
  let view = await pairing(run, serviceRequests.pairingStart(team.apiBaseUrl, workspace))
  if (view.status !== 'waiting') throw new CliRefusal('PAIRING_NOT_STARTED', 'Nessie didn\'t give a pairing code. Try again.')
  // With --json the plans are the one document on standard output; the code still has to reach the person.
  const tell = options.json ? context.err : context.out
  tell(`Pairing code: ${codeText(view.code)}   (valid for 10 minutes)\n`
    + 'In Nessie, open Computers and choose Add a computer, then enter the code.\nWaiting for Nessie…\n')
  while (view.status === 'waiting') {
    await context.sleep(POLL_MS)
    view = await pairing(run, serviceRequests.pairingStatus())
  }
  if (view.status === 'expired') {
    throw new CliTimeout('The pairing code expired before it was entered. Run nessie-computer ai plans add for a new one.')
  }
  if (view.status !== 'paired' || !view.executorId) throw new CliRefusal('PAIRING_CANCELLED', 'Nessie turned down this pairing.')
  if (!options.json) context.out(`The ChatGPT plan connection for ${team.label} is ready.\n`)
  return view.executorId
}
