import { exportedNames, selectedImports } from './author.mjs'

const base = 'apps/server/src/orchestration-v2/'
const keys = body => [...body.matchAll(/^    (\w+)(?::|,)/gm)].map(match => match[1])
const pick = (shape, names) => `Pick<${shape}, ${names.map(name => `"${name}"`).join(' | ')}>`
const fields = body => {
  const matches = [...body.matchAll(/^    (\w+)(?::|,)/gm)]
  return matches.map((match, index) => ({ name: match[1], text: body.slice(match.index, matches[index + 1]?.index) }))
}

const splitContract = (author, file, start, end, redirects, preserved = '') => {
  const originalBody = author.between(file, start, end)
  const parts = preserved ? originalBody.split(preserved) : [originalBody]
  const body = parts.join('')
  const target = file.replace('.ts', '.session-api.ts')
  redirects.set(file, target)
  const prefix = selectedImports(author.read(file), body, file, target, redirects)
  author.derive(target, [prefix, ...parts.map(part => author.sourcePart(file, part))], `extract-api:${file}`)
  const names = exportedNames(body)
  const values = new Set([...body.matchAll(/^export (?:class|const|function) (\w+)/gm)].map(match => match[1]))
  const list = names.map(name => `${values.has(name) ? '' : 'type '}${name}`).join(', ')
  author.replace(file, originalBody, `import { ${list} } from "./${target.split('/').at(-1)}";\nexport { ${list} };\n\n${preserved}`,
    `share-api:${file}`)
  return target
}

export const extractReadServices = (author, redirects) => {
  const orchestrator = base + 'Orchestrator.ts'
  const original = author.read(orchestrator)
  const originalBody = author.between(orchestrator, '    searchThreadStream: (input) =>', '\n  });\n});\n\nexport const layer:')
  const shellError = author.between(orchestrator, '  const shellProjectionError =', '  return OrchestratorV2.of({')
  const api = splitContract(author, orchestrator, 'export class OrchestratorDispatchError extends', '/** Run ordinals can skip values:', redirects)
  const target = base + 'OrchestratorReads.ts'
  const shape = pick('OrchestratorV2Shape', keys(originalBody))
  const body = `export type OrchestratorReadShape = ${shape};\n\nexport const makeOrchestratorReads = (\n  projectionStore: ProjectionStoreV2["Service"],\n  eventSink: EventSinkV2["Service"],\n): OrchestratorReadShape => {\n`
  const imports = selectedImports(original, shellError + originalBody + body, orchestrator, target, redirects)
    + `import { type OrchestratorV2Shape, OrchestratorProjectionError, OrchestratorDomainEventStreamError } from "./${api.split('/').at(-1)}";\n`
  author.derive(target, [imports, body, author.sourcePart(orchestrator, shellError), '  return {\n',
    author.sourcePart(orchestrator, originalBody), '\n  };\n};\n'], 'extract-orchestrator-reads')
  author.replace(orchestrator, shellError, '', 'move-shell-error-to-reads')
  author.replace(orchestrator, originalBody, '    ...makeOrchestratorReads(projectionStore, eventSink),', 'reuse-orchestrator-reads')
  const firstImport = author.read(orchestrator).match(/^import[\s\S]*?;/u)[0]
  author.replace(orchestrator, firstImport, 'import { makeOrchestratorReads } from "./OrchestratorReads.ts";\n' + firstImport,
    'import-orchestrator-reads')

  const threads = base + 'ThreadManagementService.ts'
  const originalThreads = author.read(threads)
  const readLocals = [
    author.between(threads, '  const ensureLegacyTranscript =', '  const ensureCommandTranscripts ='),
    author.between(threads, '  const getThreadProjection:', '  const assertDispatchTargetEnabled ='),
    author.between(threads, '  const getProjectThreadRecords:', '  const sendToThread:'),
  ]
  const resultBody = author.between(threads, '    ensureLegacyTranscript,', '\n  });\n});\n\nconst layerLegacyV1ThreadImporterNoop')
  const writeKeys = new Set(['dispatch', 'sendToThread', 'assertProviderInstanceEnabled',
    'isProviderInstanceEnabledForProject', 'hasReceipt', 'waitForThread', 'settleAfterRun', 'settleThread',
    'interruptThread', 'stopDelegatedTasks', 'stopWorkflow', 'forceStopThread', 'awaitBackgroundTasks',
    'recoverDelegatedTask', 'delegatedTaskResultPending'])
  const readFields = fields(resultBody).filter(field => !writeKeys.has(field.name))
  const readBody = readFields.map(field => field.text).join('')
  const helper = author.between(threads, 'function existingThreadIdsForCommand(', 'export type ThreadManagementTerminalRunStatus =')
  const threadsApi = splitContract(author, threads, 'export type ThreadManagementSendMode =', 'export function isActiveRun(', redirects, helper)
  const readsTarget = base + 'ThreadReads.ts'
  const shapeBody = pick('ThreadManagementServiceShape', keys(readBody))
  const prelude = `export type ThreadReadShape = ${shapeBody};\nexport const makeThreadReads = (\n  orchestrator: OrchestratorReadShape,\n  legacyImporter: LegacyV1ThreadImporter.LegacyV1ThreadImporter["Service"],\n): ThreadReadShape => {\n`
  const localImports = `import { type OrchestratorReadShape } from "./OrchestratorReads.ts";\n`
    + `import { type ThreadManagementServiceShape, ThreadTranscriptTooLargeError, ThreadManagementProjectionLoadError, ThreadManagementThreadNotFoundError, ThreadManagementProjectThreadsListError } from "./${threadsApi.split('/').at(-1)}";\n`
  author.derive(readsTarget, [selectedImports(originalThreads, readLocals.join('') + readBody + prelude,
    threads, readsTarget, redirects), localImports, prelude,
  ...readLocals.map(text => author.sourcePart(threads, text)), '  return {\n',
  // Keep each unmodified original return segment in the capsule derivation.
  ...readFields.map(field => author.sourcePart(threads, field.text)), '\n  };\n};\n'],
  'extract-thread-reads')
  for (const [index, text] of readLocals.entries()) author.replace(threads, text,
    index === 0 ? '  const reads = makeThreadReads(orchestrator, legacyImporter);\n  const { ensureLegacyTranscript, getThreadProjection, getCheckpointContext, getThreadSnapshot, getThreadTranscript, getThreadSnapshotWindow, getProjectThreadRecords, listProjectThreads } = reads;\n  const ensureProjectionTranscript = (threadId: ThreadId) => ensureLegacyTranscript(threadId).pipe(Effect.mapError((cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause })));\n\n' : '',
    `reuse-thread-read-locals:${index}`)
  // Writes retain their original implementation and reference the same read operations.
  const writeBody = fields(resultBody).filter(field => writeKeys.has(field.name)).map(field => field.text).join('')
  author.replace(threads, resultBody, `    ...reads,\n${writeBody}`,
    'reuse-thread-read-result')
  const firstThreadImport = author.read(threads).match(/^import[\s\S]*?;/u)[0]
  author.replace(threads, firstThreadImport, 'import { makeThreadReads } from "./ThreadReads.ts";\n' + firstThreadImport, 'import-thread-reads')
  return { orchestrator: target, threads: readsTarget }
}
