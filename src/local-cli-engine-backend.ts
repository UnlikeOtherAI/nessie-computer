import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { localCliModelName, type LocalCliEngine } from '@nessie/executor-protocol'

import { runCommand, type CommandRunner } from './coding-session/agent-env.js'
import { createHostProcessControl } from './coding-session/agent-guard.js'
import { resolveExecutorEntry } from './coding-session/host-spawn.js'
import type { CodingProcessControl } from './coding-session/process-control.js'
import { providerAccountIdentity } from './provider-account-identity.js'
import type { LocalInferenceBackend, ObservedInferenceModel } from './local-inference-backend.js'
import type { OllamaChatEvent } from './ollama-chat.js'
import { claudeAuthStatus, type LocalCliDetection } from './local-cli-engine-detect.js'
import { LocalCliEngineError, localCliTurnError } from './local-cli-engine-error.js'
import {
  cliEngineArguments, cliEngineEnvironment, inspectCliEngine, runCliEngineTurn, type CliProgram,
} from './local-cli-engine-process.js'
import {
  CLI_ENGINE_SYSTEM_PROMPT, cliEnginePrompt, createCliReplySplitter, parseCliToolBlock,
} from './local-cli-engine-prompt.js'

/** The identity this host gives a turn; part of every advertised digest. */
const PROTOCOL = 'nessie-local-cli-engine-v1'
const OBSERVE_TTL_MS = 15_000
const LABEL: Record<LocalCliEngine, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }
const program = (engine: LocalCliEngine): CliProgram => engine === 'claude-code' ? 'claude' : 'codex'
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export type LocalCliEngineTarget = {
  engine: LocalCliEngine
  profileId: string | null
  /** The owner's name for an added account; shown to Nessie in place of the provider account. */
  name: string | null
  detect: () => Promise<LocalCliDetection>
}

/** Owner's Stop and Nessie's session close (§11): whether an attempt's session may still run. */
export type LocalCliSessionGate = { refused: (sessionId: string) => boolean }

/** A model entry, and what a turn on it needs, from one detection. */
const observed = async (target: LocalCliEngineTarget, found: LocalCliDetection, run: CommandRunner) => {
  if (!found.installed || !found.program) return undefined
  const cli = program(target.engine)
  const inspected = await inspectCliEngine(cli, found.program.path, found.env, run).catch(() => undefined)
  const account = found.signedIn
    ? providerAccountIdentity(target.engine, found.account ?? null, null).accountKey ?? 'unnamed' : null
  const model: ObservedInferenceModel = {
    name: localCliModelName(target.engine, target.profileId),
    displayName: target.name ? `${LABEL[target.engine]} · ${target.name}` : LABEL[target.engine],
    cliEngine: target.engine, cliEngineState: found.signedIn ? 'ready' : 'signed_out',
    identitySource: 'owner_configuration', capabilities: ['completion', 'tools'],
    manifestDigest: digest([PROTOCOL, target.engine, target.profileId, account, found.program.path,
      inspected?.version ?? found.program.version]),
    numCtxCap: null, remoteHost: null, remoteModel: null, sizeBytes: null,
  }
  return { model, inspected, found }
}

/**
 * One engine connection as a local-inference backend: one advertised model,
 * and one CLI process per turn in a disposable folder, its reply streamed as
 * the CLI writes it. `stopRuns` ends every turn of the given runs.
 */
export const createLocalCliEngineBackend = (target: LocalCliEngineTarget, options: {
  run?: CommandRunner; control?: () => CodingProcessControl; sessions?: LocalCliSessionGate; now?: () => number
} = {}): LocalInferenceBackend & { stopRuns: (runIds: readonly string[]) => void } => {
  const run = options.run ?? runCommand
  const now = options.now ?? Date.now
  let cached: { at: number; models: ObservedInferenceModel[] } | undefined
  const turns = new Map<AbortController, { runId: string; sessionId?: string }>()
  const fresh = async () => observed(target, await target.detect(), run)
  return {
    observe: async () => {
      if (cached && now() - cached.at < OBSERVE_TTL_MS) return cached.models
      const current = await fresh()
      cached = { at: now(), models: current ? [current.model] : [] }
      return cached.models
    },
    stopRuns: (runIds) => {
      for (const [controller, turn] of turns) if (runIds.includes(turn.runId)) controller.abort('session_stopped')
    },
    stream: async function* (input) {
      const { attempt } = input
      if (attempt.inferenceSource !== undefined || attempt.maxOutputTokens !== undefined) {
        throw new LocalCliEngineError('unsupported_capability')
      }
      if (attempt.sessionId && options.sessions?.refused(attempt.sessionId)) {
        throw new LocalCliEngineError('session_stopped')
      }
      const prompt = cliEnginePrompt(attempt)
      const current = await fresh()
      cached = undefined
      if (!current) throw new LocalCliEngineError('cli_not_installed')
      if (current.model.cliEngineState !== 'ready') throw new LocalCliEngineError('cli_signed_out')
      if (!current.inspected) throw new LocalCliEngineError('cli_unsupported')
      if (current.model.name !== attempt.modelName || current.model.manifestDigest !== attempt.modelDigest) {
        throw new LocalCliEngineError('model_changed')
      }
      const cli = program(target.engine)
      if (cli === 'claude' && attempt.reasoningEffort && !current.inspected.help.includes('--effort')) {
        throw new LocalCliEngineError('unsupported_capability')
      }
      const controller = new AbortController()
      const forward = () => controller.abort(input.signal.reason)
      input.signal.addEventListener('abort', forward, { once: true })
      if (input.signal.aborted) forward()
      turns.set(controller, { runId: attempt.runId, ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}) })
      const folder = await mkdtemp(join(tmpdir(), 'nessie-cli-engine-'))
      const queue: string[] = []
      let wake: (() => void) | undefined
      const splitter = createCliReplySplitter()
      let heard = 0
      let done: Promise<Awaited<ReturnType<typeof runCliEngineTurn>>> | undefined
      const hear = (text: string) => {
        // Codex writes whole messages; a second one is a new paragraph.
        const chunk = splitter.push(cli === 'codex' && heard > 0 ? `\n\n${text}` : text)
        heard += 1
        if (chunk) { queue.push(chunk); wake?.() }
      }
      try {
        await mkdir(join(folder, 'tmp'), { mode: 0o700 })
        const env = cliEngineEnvironment(cli, current.found.env, folder)
        if (cli === 'claude' && !(await claudeAuthStatus(current.found.program!.path, env, run)).signedIn) {
          // A CLI that cannot read the account apart from its disposable config folder is refused, not trusted.
          throw new LocalCliEngineError('cli_signed_out')
        }
        const effort = attempt.reasoningEffort === 'low' || attempt.reasoningEffort === 'medium'
          || attempt.reasoningEffort === 'high' ? attempt.reasoningEffort : undefined
        const turn = runCliEngineTurn({ engine: cli, program: current.found.program!.path, env, cwd: folder,
          signal: controller.signal, control: options.control?.()
            ?? createHostProcessControl(resolveExecutorEntry(), { environment: process.env }),
          args: cliEngineArguments(cli, folder, { systemPrompt: CLI_ENGINE_SYSTEM_PROMPT,
            partialMessages: current.inspected.help.includes('--include-partial-messages'),
            ...(effort ? { effort } : {}) }),
          prompt, onText: hear })
        let settled = false
        done = turn.finally(() => { settled = true; wake?.() })
        done.catch(() => undefined)
        for (;;) {
          while (queue.length) yield { done: false, text: queue.shift()! } satisfies OllamaChatEvent
          if (settled) break
          await new Promise<void>((resolve) => { wake = resolve })
          wake = undefined
        }
        const result = await done.catch((error: unknown) => {
          throw controller.signal.reason === 'session_stopped' ? new LocalCliEngineError('session_stopped')
            : localCliTurnError(error)
        })
        if (heard === 0 && result.text) hear(result.text)
        const tail = splitter.tail()
        if (queue.length || tail) yield { done: false, text: queue.splice(0).join('') + tail } satisfies OllamaChatEvent
        const { block } = splitter.finish()
        if (block !== null && !attempt.tools.length) throw new LocalCliEngineError('inference_incomplete')
        const toolCalls = block === null ? [] : parseCliToolBlock(block, attempt)
        yield { done: true, finishReason: toolCalls.length ? 'tool-call' : 'stop', toolCalls,
          ...(result.inputTokens === null ? {} : { inputTokens: result.inputTokens }),
          ...(result.outputTokens === null ? {} : { outputTokens: result.outputTokens }) } satisfies OllamaChatEvent
      } finally {
        input.signal.removeEventListener('abort', forward)
        controller.abort('turn_ended')
        await done?.catch(() => undefined)
        turns.delete(controller)
        await rm(folder, { recursive: true, force: true })
      }
    },
  }
}
