import * as Effect from 'effect/Effect'
import { EnvironmentId, ThreadId } from '@nessie/t3-session-source/contracts'
import { buildThreadListV2Items, buildThreadListV2ListItems, buildArchivedThreadGroups,
  ThreadHistoryController, SourceContracts, type ThreadListV2Layout,
  type ThreadListV2ListItem, type ArchivedThreadGroup } from '@nessie/t3-session-source/client'

const identity: SourceContracts.ThreadId = ThreadId.make('original-thread-id')
const environmentId = EnvironmentId.make('original-environment-id')
const layout: ThreadListV2Layout = buildThreadListV2Items({ threads: [], environmentId,
  searchQuery: '', now: '2026-11-08T00:00:00Z' })
const rows: ReadonlyArray<ThreadListV2ListItem> = buildThreadListV2ListItems({
  items: layout.items, pendingTasks: [],
})
const archives: ReadonlyArray<ArchivedThreadGroup> = buildArchivedThreadGroups({ snapshots: [],
  environmentLabels: {}, environmentId, searchQuery: '', sortOrder: 'newest' })
const read: Effect.Effect<ThreadHistoryController.ThreadHistoryLoadEarlierResult, never,
  ThreadHistoryController.ThreadHistoryController> = Effect.gen(function* () {
  const controller = yield* ThreadHistoryController.ThreadHistoryController
  return yield* controller.loadEarlier(environmentId, identity)
})
// @ts-expect-error Original branded IDs cannot be replaced by arbitrary client strings.
const invalid: SourceContracts.ThreadId = 'not-admitted-as-an-original-id'
void [rows, archives, read, invalid]
