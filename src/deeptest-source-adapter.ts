import type { Readable, Writable } from 'node:stream'

import type { ExecutorDeepTestSourceGrant } from './state-store.js'
import { executorWorkspaceFolderNames } from './workspace-folders.js'
import { configureWorkspaceFolderPath } from './workspace.js'
import {
  DEEPTEST_SOURCE_CAPABILITIES,
  DEEPTEST_SOURCE_PROTOCOL_VERSION,
  bindingFromRequest,
  parseDeepTestSourceRequest,
  sameDeepTestSourceBinding,
  type DeepTestSourceBinding,
  type DeepTestSourceErrorCode,
  type DeepTestSourceRequest,
  type DeepTestSourceResponse,
} from './deeptest-source-protocol.js'
import {
  createDeepTestSourceSnapshot,
  DeepTestSourceSnapshotError,
  inventoryPage,
  readSnapshotFiles,
  type DeepTestSourceSnapshot,
} from './deeptest-source-snapshot.js'

const MAX_FRAME_BYTES = 1024 * 1024
const MAX_OUTPUT_FRAME_BYTES = 20 * 1024 * 1024

const response = (
  requestId: string,
  result: Record<string, unknown>,
  incomplete = false,
): DeepTestSourceResponse => ({
  protocol_version: DEEPTEST_SOURCE_PROTOCOL_VERSION,
  request_id: requestId,
  result,
  status: incomplete ? 'incomplete' : 'ok',
})

const failure = (
  requestId: string,
  code: DeepTestSourceErrorCode,
  message: string,
  retryable = false,
): DeepTestSourceResponse => ({
  error: { code, message, retryable },
  protocol_version: DEEPTEST_SOURCE_PROTOCOL_VERSION,
  request_id: requestId,
  status: 'error',
})

export const serializeDeepTestSourceResponse = (answer: DeepTestSourceResponse): string => {
  const serialized = JSON.stringify(answer)
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_OUTPUT_FRAME_BYTES) return `${serialized}\n`
  const limited = response(answer.request_id, {
    code: 'OUTPUT_BYTES_LIMIT',
    maximum_bytes: MAX_OUTPUT_FRAME_BYTES,
    message: 'Request fewer source files and continue the review.',
  }, true)
  return `${JSON.stringify(limited)}\n`
}
const requestIdFrom = (value: unknown): string => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid'
  const candidate = (value as { request_id?: unknown }).request_id
  return typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(candidate)
    ? candidate
    : 'invalid'
}

export const createDeepTestSourceAdapter = (
  state: ExecutorDeepTestSourceGrant,
  refreshState: () => Promise<ExecutorDeepTestSourceGrant> = async () => state,
) => {
  let binding: DeepTestSourceBinding | undefined
  const snapshots = new Map<string, DeepTestSourceSnapshot>()

  const folderNames = executorWorkspaceFolderNames(state.workspaceFolders).join(', ')

  const assertGrant = async (): Promise<void> => {
    const current = await refreshState()
    if (
      current.executorId !== state.executorId
      || current.workspaceFolders.length !== state.workspaceFolders.length
      || current.workspaceFolders.some((folder, index) => (
        folder.name !== state.workspaceFolders[index]?.name
        || folder.path !== state.workspaceFolders[index]?.path
      ))
      || current.descriptor.revision !== state.descriptor.revision
      || !current.descriptor.operationKeys.includes('file.list')
      || !current.descriptor.operationKeys.includes('file.read')
    ) throw new Error('CAPABILITY_UNAVAILABLE')
  }

  const dispatch = async (value: unknown): Promise<DeepTestSourceResponse> => {
    let request: DeepTestSourceRequest
    try {
      request = parseDeepTestSourceRequest(value)
    } catch {
      return failure(
        requestIdFrom(value),
        'REQUEST_INVALID',
        'The native source request is malformed or uses an unsupported protocol version.',
      )
    }
    const requestedBinding = bindingFromRequest(request)
    try {
      await assertGrant()
    } catch {
      snapshots.clear()
      return failure(request.request_id, 'CAPABILITY_UNAVAILABLE', 'The Nessie source grant is unavailable.')
    }
    if (request.operation === 'hello') {
      if (binding !== undefined && !sameDeepTestSourceBinding(binding, requestedBinding)) {
        return failure(request.request_id, 'BINDING_MISMATCH', 'This adapter is bound to another review.')
      }
      if (!state.descriptor.operationKeys.includes('file.list')
        || !state.descriptor.operationKeys.includes('file.read')) {
        return failure(
          request.request_id,
          'CAPABILITY_UNAVAILABLE',
          'Allow file.list and file.read in this Nessie executor before using it for DeepTest.',
        )
      }
      binding = requestedBinding
      return response(request.request_id, {
        capabilities: DEEPTEST_SOURCE_CAPABILITIES,
        executor_id: state.executorId,
        protocol_version: DEEPTEST_SOURCE_PROTOCOL_VERSION,
        // The names are the label: they are what an agent types and what a
        // reviewer approved, and a multi-folder executor has no single one.
        workspace_label: folderNames || 'Workspace',
      })
    }
    if (binding === undefined || !sameDeepTestSourceBinding(binding, requestedBinding)) {
      return failure(request.request_id, 'BINDING_MISMATCH', 'This adapter is bound to another review.')
    }
    if (request.operation === 'source.snapshot') {
      if (snapshots.size > 0) {
        return failure(
          request.request_id,
          'SNAPSHOT_LIMIT',
          'Release the open source snapshot before starting another one.',
        )
      }
      // A review names the host directory it expects, so that directory selects
      // which workspace folder this snapshot is of. Nothing is guessed: a root
      // that is not one of the paired folders is refused, and the snapshot
      // re-verifies the match against the folder it was handed.
      //
      // Both sides are canonicalised before they are compared. A stored folder
      // path is canonical when `configure` wrote it, but the comparison must not
      // depend on that: on macOS `/var/...` and `/private/var/...` are the same
      // directory, and a folder that only matched by spelling would refuse a
      // review of a directory it really does expose.
      const requestedRoot = await configureWorkspaceFolderPath(request.expected_source_root).catch(() => null)
      const requestedFolder = requestedRoot === null ? undefined : (await Promise.all(
        state.workspaceFolders.map(async (folder) => ({
          canonical: await configureWorkspaceFolderPath(folder.path).catch(() => null),
          folder,
        })),
      )).find((candidate) => candidate.canonical === requestedRoot)?.folder
      if (!requestedFolder) {
        return failure(
          request.request_id,
          'SOURCE_UNAVAILABLE',
          'The review source does not match a folder this Nessie executor is paired against.',
        )
      }
      try {
        const snapshot = await createDeepTestSourceSnapshot(
          requestedFolder.path,
          request.expected_source_root,
          assertGrant,
        )
        if (request.expected_commit !== snapshot.commit) {
          return failure(
            request.request_id,
            'COMMIT_MISMATCH',
            'The Nessie workspace no longer matches the commit selected for this review.',
          )
        }
        snapshots.set(snapshot.snapshot_id, snapshot)
        return response(request.request_id, {
          commit: snapshot.commit,
          coverage: snapshot.coverage,
          manifest_digest: snapshot.manifest_digest,
          snapshot_id: snapshot.snapshot_id,
          working_tree_state: snapshot.working_tree_state,
        }, !snapshot.coverage.complete)
      } catch (error) {
        if (error instanceof DeepTestSourceSnapshotError) {
          return failure(request.request_id, error.code, error.message, error.retryable)
        }
        return failure(
          request.request_id,
          'SOURCE_UNAVAILABLE',
          'The Nessie source snapshot is unavailable.',
          true,
        )
      }
    }
    const snapshot = snapshots.get(request.snapshot_id)
    if (snapshot === undefined) {
      return failure(request.request_id, 'SNAPSHOT_NOT_FOUND', 'This source snapshot is no longer open.')
    }
    if (request.operation === 'source.inventory') {
      return response(
        request.request_id,
        inventoryPage(snapshot, request.cursor, request.max_entries),
        !snapshot.coverage.complete,
      )
    }
    if (request.operation === 'source.read') {
      const read = readSnapshotFiles(snapshot, request.paths)
      return response(request.request_id, read.result, read.incomplete)
    }
    snapshots.delete(request.snapshot_id)
    return response(request.request_id, { released: true, snapshot_id: request.snapshot_id })
  }

  return {
    close: () => snapshots.clear(),
    dispatch,
    snapshotCount: () => snapshots.size,
  }
}

const frames = async function* (input: Readable): AsyncGenerator<string> {
  let pending = Buffer.alloc(0)
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    pending = Buffer.concat([pending, bytes])
    if (pending.byteLength > MAX_FRAME_BYTES && !pending.includes(0x0a)) {
      throw new Error('FRAME_TOO_LARGE')
    }
    let newline = pending.indexOf(0x0a)
    while (newline >= 0) {
      const line = pending.subarray(0, newline)
      pending = pending.subarray(newline + 1)
      if (line.byteLength > MAX_FRAME_BYTES) throw new Error('FRAME_TOO_LARGE')
      if (line.byteLength > 0) yield line.toString('utf8')
      newline = pending.indexOf(0x0a)
    }
  }
  if (pending.byteLength > 0) {
    if (pending.byteLength > MAX_FRAME_BYTES) throw new Error('FRAME_TOO_LARGE')
    yield pending.toString('utf8')
  }
}

export const serveDeepTestSourceAdapter = async (
  state: ExecutorDeepTestSourceGrant,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  refreshState: () => Promise<ExecutorDeepTestSourceGrant> = async () => state,
): Promise<void> => {
  const adapter = createDeepTestSourceAdapter(state, async () => {
    if (input.destroyed || input.readableEnded) throw new Error('INPUT_CLOSED')
    return await refreshState()
  })
  try {
    for await (const line of frames(input)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        parsed = null
      }
      const answer = await adapter.dispatch(parsed)
      if (!output.write(serializeDeepTestSourceResponse(answer))) {
        await waitForWritable(output)
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'FRAME_TOO_LARGE') throw error
    output.write(serializeDeepTestSourceResponse(failure(
      'invalid',
      'FRAME_TOO_LARGE',
      'The native source request exceeds the one-megabyte frame limit.',
    )))
  } finally {
    adapter.close()
  }
}

const waitForWritable = async (output: Writable): Promise<void> => await new Promise((resolve, reject) => {
  const cleanup = (): void => {
    output.off('drain', drained)
    output.off('close', closed)
    output.off('error', failed)
  }
  const drained = (): void => { cleanup(); resolve() }
  const closed = (): void => { cleanup(); reject(new Error('OUTPUT_CLOSED')) }
  const failed = (): void => { cleanup(); reject(new Error('OUTPUT_CLOSED')) }
  output.once('drain', drained)
  output.once('close', closed)
  output.once('error', failed)
})

