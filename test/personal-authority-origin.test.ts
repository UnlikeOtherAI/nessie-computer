import assert from 'node:assert/strict'
import test from 'node:test'
import { pairedPersonalAuthority } from '../src/personal-authority-origin.js'

const principal = { serverOrigin: 'https://protected.example', identityIssuer: 'https://identity.example',
  organizationId: 'org', teamId: 'team', ownerUserId: 'owner', ownerSubject: 'stable-subject' }
const authority = { principal, agent: { kind: 'private', id: 'agent', ownerUserId: 'owner', teamId: 'team' },
  origin: { kind: 'interactive', requestingUserId: 'owner', rootRunId: 'root' },
  runId: 'run', rootRunId: 'root', soleReaderUserId: 'owner' }

test('a different pairing cannot assert the protected custodian origin even with identical owner references', () => {
  assert.throws(() => pairedPersonalAuthority(authority, 'https://other-server.example'), /origin_invalid/u)
  assert.equal(pairedPersonalAuthority(authority, 'https://protected.example/api')?.principal.serverOrigin,
    principal.serverOrigin)
})

test('unknown metadata is rejected while missing legacy metadata remains subject to the actual guard', () => {
  assert.equal(pairedPersonalAuthority(undefined, 'https://other-server.example'), undefined)
  assert.throws(() => pairedPersonalAuthority({ principal }, 'https://protected.example'), /origin_invalid/u)
  assert.throws(() => pairedPersonalAuthority(authority, 'invalid paired endpoint'), /origin_invalid/u)
})
