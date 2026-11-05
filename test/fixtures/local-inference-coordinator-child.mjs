import { LocalInferenceCoordinator } from '../../src/local-inference-coordinator.ts'

const [, , directory, hostId] = process.argv
const coordinator = await LocalInferenceCoordinator.open({
  directory, security: process.platform === 'win32' ? { helper: async () => undefined } : {},
})
const slot = await coordinator.acquire(hostId)
process.stdout.write(JSON.stringify({ publicKey: coordinator.identity.publicKey, requestId: slot?.requestId ?? null }))
