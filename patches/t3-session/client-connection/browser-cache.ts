import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as Persistence from 't3-source:packages/client-runtime/src/platform/persistence.ts';
import { StoredOrchestrationThreadSnapshot, ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION }
  from 't3-source:packages/client-runtime/src/platform/orchestrationCache.ts';
import type { EnvironmentId, ThreadId } from '@nessie/t3-session-source/contracts';
import type { BrowserDataBoundary } from './browser-data.ts';

/** The original Persistence service and cache schema; no second projection or reducer. */
export const makeBrowserThreadCache = (data: BrowserDataBoundary, environmentId: EnvironmentId, threadId: ThreadId) => {
  const codec = Schema.fromJsonString(StoredOrchestrationThreadSnapshot);
  const error = (operation: Persistence.ConnectionPersistenceError['operation']) =>
    new Persistence.ConnectionPersistenceError({ operation, message: 'Thread cache is unavailable in this scope.' });
  const check = (environment: EnvironmentId, thread: ThreadId) => {
    if (environment !== environmentId || thread !== threadId) throw error('load-thread');
  };
  const key = JSON.stringify(['thread', environmentId, threadId]);
  return Persistence.EnvironmentCacheStore.of({
    loadThread: (environment, thread) => Effect.gen(function* () {
      const stored = yield* Effect.try({ try: () => { check(environment, thread); return data.read(key); },
        catch: () => error('load-thread') });
      if (stored === null) return Option.none();
      const cached = yield* Schema.decodeUnknownEffect(codec)(stored).pipe(
        Effect.mapError(() => error('load-thread')));
      if (cached.environmentId !== environmentId || cached.threadId !== threadId
        || cached.snapshot.projection.thread.id !== threadId) return yield* error('load-thread');
      return Option.some(cached.snapshot);
    }),
    saveThread: (environment, snapshot) => Effect.gen(function* () {
      yield* Effect.try({ try: () => check(environment, snapshot.projection.thread.id),
        catch: () => error('save-thread') });
      const encoded = yield* Schema.encodeEffect(codec)({ schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
        environmentId, threadId, snapshot }).pipe(Effect.mapError(() => error('save-thread')));
      yield* Effect.try({ try: () => data.write(key, encoded), catch: () => error('save-thread') });
    }),
    removeThread: (environment, thread) => Effect.try({ try: () => {
      check(environment, thread); data.remove(key);
    }, catch: () => error('remove-thread') }),
    clear: environment => Effect.try({ try: () => { check(environment, threadId); data.clear(); },
      catch: () => error('clear-environment') }),
    // This exact-thread host cannot read or persist environment-wide caches.
    loadShell: () => Effect.fail(error('load-shell')),
    saveShell: () => Effect.fail(error('save-shell')),
    loadServerConfig: () => Effect.fail(error('load-server-config')),
    saveServerConfig: () => Effect.fail(error('save-server-config')),
    loadVcsRefs: () => Effect.fail(error('load-vcs-refs')),
    saveVcsRefs: () => Effect.fail(error('save-vcs-refs')),
    removeVcsRefs: () => Effect.fail(error('remove-vcs-refs')),
    clearVcsRefs: () => Effect.fail(error('clear-vcs-refs')),
  });
};
