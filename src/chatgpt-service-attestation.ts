import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { ExecutorChatgptDelegationChallengeRequestSchema, ExecutorChatgptDelegationChallengeSchema,
  ExecutorChatgptDelegationConfirmSchema, ExecutorChatgptContextSchema, ExecutorChatgptDisconnectSchema,
  canonicalExecutorJson } from '@nessie/executor-protocol'
import { loadExecutorState } from './state-store.js'
import { packagedNativeHelperPath } from './state-security.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import { executorApi } from './api-client.js'
import { randomOAuthValue } from './chatgpt-oauth-provider.js'

const Operation = z.discriminatedUnion('operation', [
  z.object({ operation:z.literal('pairing') }).strict(),
  z.object({ operation:z.literal('scope'),profileId:z.string().uuid() }).strict(),
  z.object({ operation: z.literal('prepare'), profileId: z.string().uuid(), publicKey: z.string().min(32).max(1024) })
    .strict(),
  z.object({ operation: z.literal('confirm'), challengeId: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/u),
    companionSignature: z.string().min(32).max(1024),nonce:z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u) }).strict(),
  z.object({ operation:z.literal('disconnect'),profileId:z.string().uuid(),serverOrigin:z.string().url().max(512),
    organizationId:z.string().uuid(),teamId:z.string().uuid() }).strict(),
])
const execute = promisify(execFile)

/** Machine-only attestation. The native pipe separately authenticates the exact pairing-owner SID. */
export const runChatgptServiceAttestation = async (args: string[]): Promise<boolean> => {
  if (args[0] !== 'personal-chatgpt-service') return false
  if (process.platform !== 'win32' || process.env.NESSIE_EXECUTOR_PACKAGED_CLI !== '1'
    || args.length !== 4 || args[1] !== '--operation-stdin' || args[2] !== '--state-dir'
    || !isAbsolute(args[3] ?? '')) throw new Error('chatgpt_service_context_required')
  const context = await execute(packagedNativeHelperPath(), ['verify-service-context'], {
    timeout: 5000, maxBuffer: 4096, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
  })
  z.object({ status: z.literal('verified'), code: z.null().optional() }).strict().parse(JSON.parse(context.stdout))
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const part = Buffer.from(chunk as Uint8Array)
    bytes += part.length
    if (bytes > 16 * 1024) throw new Error('chatgpt_service_operation_invalid')
    chunks.push(part)
  }
  const operation = Operation.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  const state = await loadExecutorState(args[3]!)
  if (!state.connectionEpoch) throw new Error('chatgpt_service_pairing_unavailable')
  const base = { executorId: state.executorId, connectionEpoch: state.connectionEpoch,
    observedAt: new Date().toISOString(), nonce: operation.operation==='confirm' ? operation.nonce : randomOAuthValue() }
  const machine = createPrivateKey({format:'der',type:'pkcs8',key:Buffer.from(state.machinePrivateKey,'base64url')})
  if (machine.asymmetricKeyType!=='ed25519') throw new Error('chatgpt_service_pairing_unavailable')
  const machinePublicKey = createPublicKey(machine).export({format:'der',type:'spki'}).toString('base64url')
  const supplied = Buffer.from(state.machinePublicKey,'base64url')
  const machineBytes=Buffer.from(machinePublicKey,'base64url')
  if (!supplied.equals(machineBytes) && !supplied.equals(machineBytes.subarray(-32))) {
    throw new Error('chatgpt_service_pairing_unavailable')
  }
  const pairing={kind:'windows-service' as const,executorId:state.executorId,
    apiBaseUrl:new URL(state.apiBaseUrl).origin,connectionEpoch:state.connectionEpoch,
    machinePublicKeyFingerprint:`sha256:${createHash('sha256').update(machineBytes).digest('hex')}`}
  const assertPairingCurrent = async () => {
    const current = await loadExecutorState(args[3]!)
    if (current.executorId !== state.executorId || current.apiBaseUrl !== state.apiBaseUrl
      || current.connectionEpoch !== state.connectionEpoch || current.machinePublicKey !== state.machinePublicKey
      || current.machinePrivateKey !== state.machinePrivateKey) throw new Error('chatgpt_service_pairing_fenced')
  }
  if (operation.operation==='pairing') {
    await assertPairingCurrent()
    process.stdout.write(`${JSON.stringify(pairing)}\n`)
  } else if (operation.operation==='disconnect') {
    if (operation.serverOrigin!==pairing.apiBaseUrl) throw new Error('chatgpt_service_disconnect_fenced')
    const request={...base,profileId:operation.profileId,serverOrigin:operation.serverOrigin,
      organizationId:operation.organizationId,teamId:operation.teamId}
    z.object({disconnected:z.literal(true)}).strict().parse(await executorApi.personalChatgpt(state.apiBaseUrl,
      'disconnect',ExecutorChatgptDisconnectSchema.parse({...request,
        signature:signExecutorDaemonPayload(state.machinePrivateKey,'chatgpt.disconnect',request)})))
    await assertPairingCurrent()
    process.stdout.write(`${JSON.stringify({disconnected:true,pairing})}\n`)
  } else if (operation.operation === 'prepare' || operation.operation==='scope') {
    const publicKeyValue=operation.operation==='prepare' ? operation.publicKey : machinePublicKey
    const keyBytes = Buffer.from(publicKeyValue, 'base64url')
    const publicKey = createPublicKey({ format: 'der', type: 'spki', key: keyBytes })
    if (publicKey.asymmetricKeyType !== 'ed25519'
      || publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') !== publicKeyValue) {
      throw new Error('chatgpt_service_companion_key_invalid')
    }
    const request = { ...base, profileId: operation.profileId, publicKey: publicKeyValue,
      serverOrigin: new URL(state.apiBaseUrl).origin }
    const challenge = ExecutorChatgptDelegationChallengeSchema.parse(await executorApi.personalChatgpt(state.apiBaseUrl,
      'challenge', ExecutorChatgptDelegationChallengeRequestSchema.parse({ ...request,
        signature: signExecutorDaemonPayload(state.machinePrivateKey, 'chatgpt.challenge', request) })))
    const { digest, ...authority } = challenge
    if (challenge.executorId !== state.executorId || challenge.profileId !== operation.profileId
      || challenge.connectionEpoch !== state.connectionEpoch
      || challenge.principal.serverOrigin !== request.serverOrigin
      || challenge.publicKeyFingerprint !== `sha256:${createHash('sha256').update(keyBytes).digest('hex')}`
      || Date.parse(challenge.expiresAt) <= Date.now() || Date.parse(challenge.expiresAt) > Date.now() + 60_000
      || digest !== createHash('sha256').update(canonicalExecutorJson(authority)).digest('hex')) {
      throw new Error('chatgpt_service_challenge_fenced')
    }
    await assertPairingCurrent()
    process.stdout.write(`${JSON.stringify({pairing,challenge})}\n`)
  } else {
    const request = { ...base, challengeId: operation.challengeId, digest: operation.digest,
      companionSignature: operation.companionSignature }
    const delegated = ExecutorChatgptContextSchema.parse(await executorApi.personalChatgpt(state.apiBaseUrl,
      'delegate', ExecutorChatgptDelegationConfirmSchema.parse({ ...request,
        signature: signExecutorDaemonPayload(state.machinePrivateKey, 'chatgpt.delegate', request) })))
    if (delegated.executorId !== state.executorId || delegated.connectionEpoch !== state.connectionEpoch
      || delegated.nonce !== request.nonce || delegated.principal.serverOrigin !== new URL(state.apiBaseUrl).origin
      || Date.parse(delegated.expiresAt) <= Date.now() || Date.parse(delegated.expiresAt) > Date.now() + 15 * 60_000) {
      throw new Error('chatgpt_service_delegation_fenced')
    }
    await assertPairingCurrent()
    process.stdout.write(`${JSON.stringify({pairing,context:delegated})}\n`)
  }
  return true
}
