import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { canonicalExecutorJson, ExecutorChatgptContextSchema, ExecutorChatgptDelegationChallengeSchema,
  samePersonalInferenceCustodian, type ExecutorChatgptContext, type PersonalChatgptConnectIntent,
  type ExecutorChatgptDelegationChallenge } from '@nessie/executor-protocol'
import { packagedRuntimeDirectory } from './runtime-integrity.js'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'
import { randomOAuthValue } from './chatgpt-oauth-provider.js'
import { chatgptCompanionFingerprint, signChatgptCompanionProof,
  type ChatgptCompanionKey } from './chatgpt-companion-proof.js'
import type { ChatgptProfileRecord } from './chatgpt-profile-records.js'

const PREFIX = 'windows-service:'
const Epoch = z.string().regex(/^[1-9][0-9]{0,18}$/u)
const Fingerprint = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
export const WindowsServicePairingSchema = z.object({ kind: z.literal('windows-service'),
  executorId: z.string().uuid(), apiBaseUrl: z.string().url().max(512), connectionEpoch: Epoch,
  machinePublicKeyFingerprint: Fingerprint }).strict()
export type WindowsServicePairing = z.infer<typeof WindowsServicePairingSchema>
export type WindowsServiceOperation = { operation: 'pairing' } | { operation: 'scope'; profileId: string }
  | { operation: 'prepare'; profileId: string; publicKey: string }
  | { operation: 'confirm'; challengeId: string; digest: string; companionSignature: string; nonce: string }
  | { operation: 'disconnect'; profileId: string; serverOrigin: string; organizationId: string; teamId: string }
export type WindowsServiceTransport = (executorId: string, operation: WindowsServiceOperation) => Promise<unknown>
const refuse = (): never => { throw new PersonalInferenceProtectionError('chatgpt_owner_authority_unavailable') }

/** An ephemeral connection reference; no state file, machine key or copied owner profile. */
export const windowsServiceReference = (executorId: string): string => `${PREFIX}${z.string().uuid().parse(executorId)}`
export const windowsServiceExecutorId = (reference: string): string | null => reference.startsWith(PREFIX)
  ? z.string().uuid().parse(reference.slice(PREFIX.length)) : null

/** Windows personal authority belongs to the service, never a copied user pairing key. */
export const requireChatgptServiceAuthority = (reference: string, platform = process.platform): void => {
  if (platform === 'win32' && !windowsServiceExecutorId(reference)) refuse()
}

/** The signed native bridge authenticates the actual service before sending this public proof. */
export const callWindowsServiceAuthority: WindowsServiceTransport = async (executorId, operation) => {
  if (process.platform !== 'win32' || process.env.NESSIE_EXECUTOR_PACKAGED_CLI !== '1') return refuse()
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('NODE_') && !key.startsWith('NESSIE_TEST_') && !key.startsWith('NESSIE_MANAGED_')
    && !key.startsWith('NESSIE_EXECUTOR_NATIVE_')))
  const child = spawn(join(packagedRuntimeDirectory(), 'nessie-executor-tray.exe'),
    ['--personal-attestation', z.string().uuid().parse(executorId)], {
      env: environment, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    })
  const bytes = Buffer.from(JSON.stringify(operation))
  if (bytes.length > 16 * 1024) { child.kill(); return refuse() }
  return await new Promise<unknown>((resolve, reject) => {
    let output = Buffer.alloc(0)
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) { child.kill(); reject(error); return }
      try {
        if (!output.length || output.length > 128 * 1024 || output.at(-1) !== 10) return refuse()
        resolve(JSON.parse(output.toString('utf8')) as unknown)
      } catch { reject(new PersonalInferenceProtectionError('chatgpt_owner_authority_unavailable')) }
    }
    const timer = setTimeout(() => finish(
      new PersonalInferenceProtectionError('chatgpt_owner_authority_unavailable')), 15000)
    child.once('error', error => finish(error))
    child.stdin.once('error', error => finish(error))
    child.stdout.on('data', (chunk: Buffer) => {
      output = Buffer.concat([output, chunk])
      if (output.length > 128 * 1024) {
        finish(new PersonalInferenceProtectionError('chatgpt_owner_authority_unavailable'))
      }
    })
    child.once('close', code => finish(code === 0 ? undefined
      : new PersonalInferenceProtectionError('chatgpt_owner_authority_unavailable')))
    child.stdin.end(bytes)
  })
}

export class WindowsServiceChatgptAuthority {
  readonly executorId: string
  constructor(reference: string,
    private readonly options: { transport?: WindowsServiceTransport; now?: () => number } = {}) {
    this.executorId = windowsServiceExecutorId(reference) ?? refuse()
  }
  private get now(): () => number { return this.options.now ?? Date.now }
  private call(operation: WindowsServiceOperation): Promise<unknown> {
    return (this.options.transport ?? callWindowsServiceAuthority)(this.executorId, operation)
  }
  private pairing(value: unknown): WindowsServicePairing {
    const pairing = WindowsServicePairingSchema.parse(value)
    if (pairing.executorId !== this.executorId || new URL(pairing.apiBaseUrl).origin !== pairing.apiBaseUrl) {
      return refuse()
    }
    return pairing
  }
  async read(): Promise<WindowsServicePairing> { return this.pairing(await this.call({ operation: 'pairing' })) }
  private match(pairing: WindowsServicePairing, intent: PersonalChatgptConnectIntent): void {
    if (pairing.executorId !== intent.executorId || pairing.apiBaseUrl !== intent.apiOrigin) refuse()
  }
  async matching(intent: PersonalChatgptConnectIntent): Promise<WindowsServicePairing> {
    const pairing = await this.read(); this.match(pairing, intent); return pairing
  }
  private async unchanged(pairing: WindowsServicePairing): Promise<void> {
    if (canonicalExecutorJson(await this.read()) !== canonicalExecutorJson(pairing)) refuse()
  }
  private challenge(value: unknown, pairing: WindowsServicePairing, profileId: string,
    fingerprint: string): ExecutorChatgptDelegationChallenge {
    const challenge = ExecutorChatgptDelegationChallengeSchema.parse(value)
    const { digest, ...body } = challenge
    if (challenge.executorId !== pairing.executorId || challenge.connectionEpoch !== pairing.connectionEpoch
      || challenge.profileId !== profileId || challenge.principal.serverOrigin !== pairing.apiBaseUrl
      || challenge.publicKeyFingerprint !== fingerprint || Date.parse(challenge.expiresAt) <= this.now()
      || Date.parse(challenge.expiresAt) > this.now() + 60_000
      || digest !== createHash('sha256').update(canonicalExecutorJson(body)).digest('hex')) return refuse()
    return challenge
  }
  async principal(profileId: string) {
    const pairing = await this.read()
    const reply = z.object({ pairing: WindowsServicePairingSchema,
      challenge: ExecutorChatgptDelegationChallengeSchema })
      .strict().parse(await this.call({ operation: 'scope', profileId: z.string().uuid().parse(profileId) }))
    if (canonicalExecutorJson(reply.pairing) !== canonicalExecutorJson(pairing)) return refuse()
    const challenge = this.challenge(reply.challenge, pairing, profileId, pairing.machinePublicKeyFingerprint)
    await this.unchanged(pairing)
    return challenge.principal
  }
  async renew(input: { intent: PersonalChatgptConnectIntent; profile: ChatgptProfileRecord; key: ChatgptCompanionKey }):
  Promise<ExecutorChatgptContext> {
    const pairing = await this.matching(input.intent)
    if (input.profile.profileId !== input.intent.profileId || input.profile.publicKey !== input.key.publicKey) {
      return refuse()
    }
    const fingerprint = chatgptCompanionFingerprint(input.key)
    const reply = z.object({ pairing: WindowsServicePairingSchema,
      challenge: ExecutorChatgptDelegationChallengeSchema }).strict().parse(await this.call({ operation: 'prepare',
      profileId: input.profile.profileId, publicKey: input.key.publicKey }))
    if (canonicalExecutorJson(reply.pairing) !== canonicalExecutorJson(pairing)) return refuse()
    const challenge = this.challenge(reply.challenge, pairing, input.profile.profileId, fingerprint)
    if (challenge.principal.organizationId !== input.intent.organizationId
      || challenge.principal.teamId !== input.intent.teamId
      || input.profile.principal && !samePersonalInferenceCustodian(input.profile.principal, challenge.principal)) {
      return refuse()
    }
    // Recheck before proof delivery as well as after confirmation. A replacement
    // pairing never receives the original companion's response.
    await this.unchanged(pairing)
    const proof = { challengeId: challenge.challengeId, digest: challenge.digest }
    const nonce = randomOAuthValue()
    const delegated = z.object({ pairing: WindowsServicePairingSchema, context: ExecutorChatgptContextSchema })
      .strict().parse(await this.call({ operation: 'confirm', ...proof, nonce,
        companionSignature: signChatgptCompanionProof(input.key, proof) }))
    const context = delegated.context
    if (canonicalExecutorJson(delegated.pairing) !== canonicalExecutorJson(pairing)
      || context.nonce !== nonce || context.executorId !== pairing.executorId
      || context.profileId !== input.profile.profileId || context.connectionEpoch !== pairing.connectionEpoch
      || context.publicKeyFingerprint !== fingerprint || context.deployment !== challenge.deployment
      || canonicalExecutorJson(context.principal) !== canonicalExecutorJson(challenge.principal)
      || Date.parse(context.expiresAt) <= this.now() || Date.parse(context.expiresAt) > this.now() + 15 * 60_000
      || Date.parse(context.observedAt) > this.now() + 5000) return refuse()
    await this.unchanged(pairing)
    return context
  }
  async disconnect(profile: ChatgptProfileRecord): Promise<void> {
    const pairing = await this.matching({ version: 1, kind: 'personal-chatgpt-connect', apiOrigin: profile.apiOrigin,
      executorId: profile.executorId, organizationId: profile.organizationId,
      teamId: profile.teamId, profileId: profile.profileId })
    const reply = z.object({ disconnected: z.literal(true), pairing: WindowsServicePairingSchema }).strict()
      .parse(await this.call({ operation: 'disconnect', profileId: profile.profileId, serverOrigin: profile.apiOrigin,
        organizationId: profile.organizationId, teamId: profile.teamId }))
    if (canonicalExecutorJson(reply.pairing) !== canonicalExecutorJson(pairing)) return refuse()
    await this.unchanged(pairing)
  }
}
