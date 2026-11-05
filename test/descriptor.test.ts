import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import test from 'node:test'

import {
  canonicalExecutorPayload,
  ExecutorSignedDescriptorSchema,
  EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS,
} from '@nessie/executor-protocol'

import { assertHostSupportsOperations, buildSignedDescriptor } from '../src/descriptor.js'
import type { ExecutorHost } from '../src/host-platform.js'

const keys = () => {
  const pair = generateKeyPairSync('ed25519')
  return {
    privateKeyDer: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKey: pair.publicKey,
  }
}

const workspacePolicy = {
  limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
  operationKeys: [...EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS],
  profiles: ['workspace_sandbox'],
  revision: 1,
}

const linuxWithKvm: ExecutorHost = {
  platform: { architecture: 'x64', os: 'linux', osMajorVersion: 6 },
  sandboxBackend: 'firecracker',
  supervisor: 'service',
}

const linuxWithoutKvm: ExecutorHost = { ...linuxWithKvm, sandboxBackend: 'none' }

const windowsWithoutHyperV: ExecutorHost = {
  platform: { architecture: 'x64', os: 'windows', osMajorVersion: 19045 },
  sandboxBackend: 'none',
  supervisor: 'desktop',
}

test('a signed descriptor carries the host facts and verifies against its own key', () => {
  const { privateKeyDer, publicKey } = keys()
  const signed = buildSignedDescriptor(privateKeyDer, {
    ...workspacePolicy,
    operationKeys: ['file.list', 'file.read', 'workspace.review', 'sandbox.stop', 'command.run'],
  }, linuxWithKvm)

  assert.deepEqual(signed.descriptor.platform, linuxWithKvm.platform)
  assert.equal(signed.descriptor.sandboxBackend, 'firecracker')
  assert.equal(signed.descriptor.supervisor, 'service')
  assert.equal(signed.descriptor.protocolVersion, 1)
  // Round-trips through the wire schema and the canonical signing payload.
  const parsed = ExecutorSignedDescriptorSchema.parse(JSON.parse(JSON.stringify(signed)))
  assert.equal(
    verify(
      null,
      Buffer.from(canonicalExecutorPayload('nessie.executor.descriptor.v1', parsed.descriptor)),
      publicKey,
      Buffer.from(parsed.signature, 'base64url'),
    ),
    true,
  )
  // Canonicalization sorts keys, so the new facts cannot shift the payload of
  // a descriptor whose other fields are unchanged: flipping one fails.
  assert.equal(
    verify(
      null,
      Buffer.from(canonicalExecutorPayload('nessie.executor.descriptor.v1', {
        ...parsed.descriptor,
        supervisor: 'desktop',
      })),
      publicKey,
      Buffer.from(parsed.signature, 'base64url'),
    ),
    false,
  )
})

test('a host with no sandbox backend still signs the workspace bundle', () => {
  const { privateKeyDer } = keys()
  const signed = buildSignedDescriptor(privateKeyDer, workspacePolicy, linuxWithoutKvm)
  assert.deepEqual(
    signed.descriptor.operationKeys,
    [...EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS],
  )
  assert.deepEqual(signed.descriptor.profiles, ['workspace_sandbox'])
  assert.equal(signed.descriptor.sandboxBackend, 'none')
})

test('a sandbox operation on a host with no backend is refused with its remedy', () => {
  const { privateKeyDer } = keys()
  assert.throws(
    () => buildSignedDescriptor(privateKeyDer, {
      ...workspacePolicy,
      operationKeys: [...EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS, 'command.run'],
    }, linuxWithoutKvm),
    /command\.run[\s\S]*kvm` group/,
  )
  assert.throws(
    () => buildSignedDescriptor(privateKeyDer, {
      ...workspacePolicy,
      operationKeys: [...EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS, 'coding.launch', 'coding.observe'],
      profiles: ['workspace_sandbox', 'coding_session'],
    }, windowsWithoutHyperV),
    /Hyper-V/,
  )
})

test('a host with a backend accepts every operation the bundle rules allow', () => {
  assert.doesNotThrow(() => assertHostSupportsOperations(
    linuxWithKvm,
    ['file.read', 'command.run', 'browser.open'],
    ['workspace_sandbox', 'coding_session'],
  ))
})
