import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { decodeExecutorT3Request, requestTargets } from '@nessie/executor-protocol/t3-session'

const route = { transportVersion: 1, protocolVersion: 2,
  sourceRevision: '25bf84ab07f53f141c20239c63e383823a9d5ea0', executorId: randomUUID(),
  environmentId: 'environment:opaque', connectionEpoch: '1', runtimeGeneration: 'generation:one',
  correlationId: 'request:one', relayOrdinal: 1, kind: 'request', method: 'projects.mutate', commandId: 'project:mutation' }

test('project mutations retain exact project and independent workspace authorization targets', () => {
  for (const type of ['project.create', 'project.update']) {
    for (const workspaceRoot of ['/allowed/workspace', '/denied/workspace', 'C:\\denied\\workspace', '//host/share']) {
      const request = decodeExecutorT3Request({ ...route,
        input: { type, commandId: route.commandId, projectId: 'project:opaque/id', title: 'Synthetic', workspaceRoot } })
      const targets = requestTargets(request)
      assert.deepEqual(targets, [
        { kind: 'project', id: 'project:opaque/id', scope: type === 'project.create' ? 'create' : 'existing' },
        { kind: 'workspace', id: workspaceRoot, scope: 'resolve' },
      ])
      // T09/T15 must resolve the workspace separately even for an admitted project.
    }
  }
  const rename = decodeExecutorT3Request({ ...route,
    input: { type: 'project.update', commandId: route.commandId, projectId: 'project:opaque/id', title: 'Renamed' } })
  assert.deepEqual(requestTargets(rename), [{ kind: 'project', id: 'project:opaque/id', scope: 'existing' }])
  assert.throws(() => decodeExecutorT3Request({ ...route,
    input: { type: 'project.create', commandId: route.commandId, projectId: 'project:opaque/id',
      name: 'Synthetic', workspaceRoot: '/workspace' } }))
})
