import { createInterface } from 'node:readline'
import { PersonalInferenceGuard } from '../../src/personal-inference-guard.ts'
import { verifyInferenceTestState } from './local-inference-security.ts'

const guard = PersonalInferenceGuard.open({
  directory: process.argv[2], security: { platform: 'win32', helper: verifyInferenceTestState },
  verifyRuntimeInventory: async () => true,
})
await guard.activate({ profileId: 'profile-a', principal: {
  serverOrigin: 'https://selfhost.example', identityIssuer: 'https://identity.example',
  organizationId: 'org', teamId: 'team', ownerUserId: 'owner', ownerSubject: 'subject',
}, backgroundConsentRevision: null }, async () => {
  process.stdout.write('activation-held\n')
  const input = createInterface({ input: process.stdin })
  await input[Symbol.asyncIterator]().next()
  input.close()
})
