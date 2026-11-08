import * as Effect from 'effect/Effect'
import type * as Layer from 'effect/Layer'
import type * as HttpClient from 'effect/http/HttpClient'
import { EnvironmentId, ThreadId } from '@nessie/t3-session-source/contracts'
import { buildThreadListV2Items, buildThreadListV2ListItems, buildArchivedThreadGroups,
  BrowserThreadHost, EnvironmentSupervisor, Persistence, BoundedThreadSnapshotLoader,
  ConnectionResolver, ConnectionCredentials, BearerAuthorization,
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
const openHost: (input: BrowserThreadHost.BrowserThreadHostInput) =>
  Promise<BrowserThreadHost.BrowserThreadHostHandle> = BrowserThreadHost.open
type Required<A> = A extends Effect.Effect<infer _Value, infer _Error, infer Services> ? Services : never
const originalSupervisorRequired: EnvironmentSupervisor.EnvironmentSupervisor extends
  Required<ReturnType<typeof import('@nessie/t3-session-source/client').Threads.makeEnvironmentThreadState>>
  ? true : false = true
void [openHost, originalSupervisorRequired, Persistence.EnvironmentCacheStore, BoundedThreadSnapshotLoader.layer]
// A bearer-only host must not acquire primary, SSH, cloud-session or relay services.
const bearerResolver: Layer.Layer<ConnectionResolver.ConnectionResolver, never,
  ConnectionCredentials.ConnectionCredentialStore | BearerAuthorization.RemoteEnvironmentAuthorization
  | HttpClient.HttpClient> = ConnectionResolver.layerBearer
void bearerResolver
