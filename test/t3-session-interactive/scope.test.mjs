import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Schema from 'effect/Schema'
import { WsRpcGroup, DeviceServiceState, TerminalAttachStreamEvent } from '@nessie/t3-session-source/contracts'
import { decodeInteractiveInput, interactiveDescriptor, interactiveOperations } from '../../dist/t3-session/interactive/operations.js'
import { constrainInteractiveRequest, requireInteractiveSource } from '../../dist/t3-session/interactive/scope.js'
import { constrainTerminalEvent, devicesForScope, terminalMetadataForScope } from '../../dist/t3-session/interactive/projections.js'
import { scope, snapshot } from './fixture.mjs'

const request = (method, input, admitted = scope) => constrainInteractiveRequest(admitted, scope,
  { method, input: decodeInteractiveInput(method, input) })

test('inventory retains the exact original descriptors and excludes installation/account operations', () => {
  for (const method of Object.keys(interactiveOperations)) {
    assert.equal(interactiveDescriptor(method), WsRpcGroup.requests.get(method))
  }
  for (const method of ['device.configure', 'device.shutdown', 'device.easAccount', 'preview.clearProfile',
    'preview.stopLocalServer', 'server.updateProvider']) assert.equal(interactiveOperations[method], undefined)
  assert.throws(() => decodeInteractiveInput('device.list', { inspectOnly: true, unexpected: true }))
})

test('source IDs, epoch and generation compare exactly without numeric conversion', () => {
  requireInteractiveSource(scope, scope)
  for (const key of ['executorId', 'environmentId', 'threadId', 'connectionEpoch', 'runtimeGeneration']) {
    assert.throws(() => requireInteractiveSource(scope, { ...scope, [key]: `${scope[key]}:other` }), /resource_mismatch/u)
  }
})

test('observation cannot become attach/open/input/resize/clear/close under a read scope', () => {
  const read = { ...scope, access: 'read' }
  const target = { threadId: scope.threadId, terminalId: 'term:one' }
  request('terminal.observe', target, read)
  for (const [method, extra] of [
    ['terminal.attach', { resume: true }], ['terminal.open', scope.workspace], ['terminal.write', { data: 'echo hi\r' }],
    ['terminal.resize', { cols: 80, rows: 24 }], ['terminal.clear', {}], ['terminal.close', {}],
  ]) assert.throws(() => request(method, { ...target, ...extra }, read), /operate_required/u)
})

test('terminal workspace, explicit target and credential overlay restrictions precede host access', () => {
  const target = { threadId: scope.threadId, terminalId: 'term:one' }
  request('terminal.open', { ...target, ...scope.workspace })
  request('terminal.attach', { ...target, resume: true })
  for (const input of [
    { ...target, cwd: 'C:/other' }, { ...target, worktreePath: null },
    { ...target, terminalId: 'foreign' }, { ...target, threadId: 'foreign' },
  ]) assert.throws(() => request('terminal.attach', input), /resource_mismatch/u)
  assert.throws(() => request('terminal.attach', { ...target, env: { TOKEN: 'synthetic' } }), /unsupported_operation/u)
  assert.throws(() => request('terminal.close', { threadId: scope.threadId }), /resource_mismatch/u)
  assert.throws(() => decodeInteractiveInput('terminal.resize', { ...target, cols: 1001, rows: 24 }))
  assert.throws(() => decodeInteractiveInput('terminal.write', { ...target, data: 'x'.repeat(65_537) }))
})

test('threadless device operations require exact association; list never installs or retries', () => {
  request('device.list', { inspectOnly: true })
  for (const input of [{}, { inspectOnly: false }, { inspectOnly: true, updateTool: 'hub' },
    { inspectOnly: true, retryHostId: 'local' }]) {
    assert.throws(() => request('device.list', input), /unsupported_operation/u)
  }
  request('device.detail', { deviceId: 'device:one' })
  assert.throws(() => request('device.detail', { deviceId: 'device:one', hostId: 'another' }), /resource_mismatch/u)
  assert.throws(() => request('device.open', { threadId: scope.threadId, deviceId: 'device:one', platform: 'ios' }),
    /unsupported_operation/u)
  request('device.open', { threadId: scope.threadId, deviceId: 'device:one', platform: 'ios', boot: false })
  assert.throws(() => request('device.open', {
    threadId: scope.threadId, deviceId: 'device:one', platform: 'android', boot: false,
  }), /resource_mismatch/u)
  assert.throws(() => request('device.action', { deviceId: 'device:one', type: 'openUrl', url: 'https://example.test' }),
    /unsupported_operation/u)
})

test('original terminal output, nested snapshots and metadata cannot disclose another resource', () => {
  const event = Schema.decodeUnknownSync(TerminalAttachStreamEvent)({ type: 'snapshot', snapshot })
  assert.equal(constrainTerminalEvent(scope, 'term:one', event), event)
  assert.throws(() => constrainTerminalEvent(scope, 'term:one', {
    type: 'restarted', threadId: scope.threadId, terminalId: 'term:one', snapshot: { ...snapshot, terminalId: 'foreign' },
  }), /resource_mismatch/u)
  const summary = { ...snapshot, hasRunningSubprocess: false }
  const filtered = terminalMetadataForScope(scope, { type: 'snapshot', terminals: [
    summary, { ...summary, threadId: 'foreign' }, { ...summary, terminalId: 'foreign' },
  ] })
  assert.deepEqual(filtered.terminals, [summary])
  assert.equal(terminalMetadataForScope(scope, { type: 'remove', threadId: 'foreign', terminalId: 'term:one' }), undefined)
})

test('device state retains unavailable hardware reasons and removes foreign boot/session rows before encoding', () => {
  const device = { hostId: 'local', id: 'device:one', platform: 'ios', name: 'fixture', version: '26',
    booted: false, physical: false }
  const host = { id: 'local', kind: 'local', label: 'Fixture', platforms: [
    { platform: 'ios', available: false, reason: 'fixture hardware unavailable' },
  ], hubInstalled: false, agentDeviceInstalled: false }
  const state = Schema.decodeUnknownSync(DeviceServiceState)({
    hosts: [host, { ...host, id: 'foreign' }], hostStatus: 'failed', hostStatusDetail: 'foreign-sensitive-detail',
    hostStatuses: { local: { status: 'failed', detail: 'fixture hardware unavailable' }, foreign: { status: 'ready' } },
    devices: [device, { ...device, id: 'foreign' }], sessions: [],
    bootingDevices: [{ ...device, threadId: 'foreign' }], supportsHostRetry: true, supportsToolUpdate: true,
    onboardingCompleted: true, agentAccessEnabled: false, hubBasePath: '/api/device-hub', revision: 8,
  })
  const result = devicesForScope(scope, state)
  const wire = Schema.encodeSync(DeviceServiceState)(result)
  assert.equal(wire.hosts.length, 1)
  assert.equal(wire.hosts[0].platforms[0].available, false)
  assert.equal(wire.hostStatuses.local.detail, 'fixture hardware unavailable')
  assert.deepEqual(wire.bootingDevices, [])
  assert.equal(wire.supportsToolUpdate, false)
  assert.equal(JSON.stringify(wire).includes('foreign'), false)
})
