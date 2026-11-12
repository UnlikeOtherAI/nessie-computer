import { localCommandPolicyOf } from './command-policy.js'
import { configureExecutorLocalPolicy } from './pair.js'
import { programRequestRule } from './program-request-gate.js'
import {
  listProgramRequests,
  ProgramRequestError,
  waitingProgramRequest,
  writeProgramRequestAnswer,
  type ProgramRequest,
  type ProgramRequestAnswer,
} from './program-requests.js'
import type { ExecutorLocalState } from './state-store.js'

/**
 * `program-requests` and `program-request answer`: the owner's side of a
 * program request (`program-requests.ts`). Both work only on the owner's own
 * state directory, which is what makes a request answerable only on this
 * computer, by its owner.
 */

const commandLine = (request: ProgramRequest): string => [request.program, ...request.args].join(' ')

export const printProgramRequests = async (
  stateDir: string, json: boolean, write: (text: string) => void,
): Promise<void> => {
  const requests = await listProgramRequests(stateDir)
  if (json) {
    write(`${JSON.stringify(requests)}\n`)
    return
  }
  if (requests.length === 0) {
    write('No program requests are waiting.\n')
    return
  }
  for (const request of requests) {
    write(`${request.id}\n  ${commandLine(request)}\n  Waits for your answer until ${request.expiresAt}.\n`)
  }
}

/**
 * Answers one waiting request. "always" first saves `<program> *` through the
 * ordinary policy writer, so the running team applies it live; only once that
 * is saved does the answer reach the daemon, so a failed save leaves the
 * request waiting for another answer. A program named by its path is saved by
 * its file name: later launches by that name start without asking, while a
 * launch by path still asks, because no rule can name a path.
 */
export const answerProgramRequest = async (
  stateDir: string,
  state: ExecutorLocalState,
  input: { answer: ProgramRequestAnswer; id: string; json: boolean },
  write: (text: string) => void,
): Promise<void> => {
  const request = await waitingProgramRequest(stateDir, input.id)
  if (input.answer === 'always') {
    const rule = programRequestRule(request.program)
    if (!rule) {
      throw new ProgramRequestError('PROGRAM_REQUEST_RULE_NOT_SAVED',
        `${request.program} cannot be saved as a rule. Choose once or deny.`)
    }
    const rules = localCommandPolicyOf(state)
    if (!rules.allowlist.includes(rule)) {
      await configureExecutorLocalPolicy(stateDir, state, state.descriptor.operationKeys,
        undefined, undefined, undefined, undefined, undefined, {}, { ...rules, allowlist: [...rules.allowlist, rule] })
        .catch((error: unknown) => {
          throw new ProgramRequestError('PROGRAM_REQUEST_RULE_NOT_SAVED', `${rule} was not saved, so the request still waits: ${
            error instanceof Error ? error.message : String(error)}`)
        })
    }
  }
  await writeProgramRequestAnswer(stateDir, request.id, input.answer)
  if (input.json) {
    write(`${JSON.stringify(await listProgramRequests(stateDir))}\n`)
    return
  }
  write(input.answer === 'once' ? `Allowed ${request.program} this once.\n`
    : input.answer === 'always' ? `${request.program} is now always allowed for this team.\n`
      : `${request.program} was not allowed.\n`)
}
