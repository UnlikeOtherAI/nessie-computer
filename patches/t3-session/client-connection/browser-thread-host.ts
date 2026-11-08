import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Scope from 'effect/Scope';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import * as SubscriptionRef from 'effect/SubscriptionRef';
import { ORCHESTRATION_V2_WS_METHODS, EnvironmentAuthInvalidError, EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError, type ThreadId, type OrchestrationV2GetTurnItemInput }
  from '@nessie/t3-session-source/contracts';
import type { RelayEnvironmentConnectResponse } from '@nessie/t3-session-source/contracts/relay';
import { bootstrapRemoteBearerSession } from 't3-source:packages/client-runtime/src/authorization/remote.ts';
import { fetchRemoteEnvironmentDescriptor } from 't3-source:packages/client-runtime/src/environment/descriptor.ts';
import { normalizeHttpBaseUrl, environmentWebSocketUrl }
  from 't3-source:packages/client-runtime/src/environment/endpoint.ts';
import { orchestrationProtocolCompatibilityError }
  from 't3-source:packages/client-runtime/src/connection/compatibility.ts';
import { BearerConnectionTarget, ConnectionBlockedError }
  from 't3-source:packages/client-runtime/src/connection/model.ts';
import { BearerConnectionCredential, BearerConnectionProfile, BearerConnectionRegistration,
  connectionRegistrationCatalogEntry, type ConnectionCredential }
  from 't3-source:packages/client-runtime/src/connection/catalog.ts';
import { credentialConnectionId } from 't3-source:packages/client-runtime/src/connection/routes.ts';
import { ConnectionCredentialStore } from 't3-source:packages/client-runtime/src/connection/credentialStore.ts';
import * as Supervisor from 't3-source:packages/client-runtime/src/connection/supervisor.ts';
import * as Persistence from 't3-source:packages/client-runtime/src/platform/persistence.ts';
import * as Threads from 't3-source:packages/client-runtime/src/state/threads.ts';
import * as History from 't3-source:packages/client-runtime/src/state/threadHistoryController.ts';
import * as Bounded from 't3-source:packages/client-runtime/src/state/boundedThreadSnapshotHttp.ts';
import { request, type EnvironmentRpcSuccess } from 't3-source:packages/client-runtime/src/rpc/client.ts';
import { createBrowserDataBoundary } from './browser-data.ts';
import { makeBrowserThreadCache } from './browser-cache.ts';
import { browserHostDriver, browserHostPlatform } from './browser-host-layers.ts';

export interface BrowserThreadHostInput {
  readonly connection: RelayEnvironmentConnectResponse;
  readonly threadId: ThreadId;
  /** Current team content generation + checked detail identity. Never credentials or authority. */
  readonly scopeKey: string;
  readonly authorizationExpiresAt: string;
  readonly signal: AbortSignal;
  readonly onState: (state: Threads.EnvironmentThreadState) => void;
}
export interface BrowserThreadHostHandle {
  /** Clears presentation on retirement without inventing an original thread state. */
  readonly closed: Promise<void>;
  readonly loadEarlier: (throughEntryId?: string, workAnchorId?: string) =>
    Promise<History.ThreadHistoryLoadEarlierResult>;
  readonly readItem: (input: OrchestrationV2GetTurnItemInput, signal: AbortSignal) =>
    Promise<EnvironmentRpcSuccess<typeof ORCHESTRATION_V2_WS_METHODS.getTurnItem>>;
  readonly dispose: () => Promise<void>;
}

let generation = 0;
let active: { readonly dispose: () => Promise<void> } | undefined;
let setupQueue = Promise.resolve();
const denied = () => new Error('T3_BROWSER_THREAD_HOST_RETIRED');

/** One current detail host per browser realm, using the original scoped state and transport. */
export function open(input: BrowserThreadHostInput): Promise<BrowserThreadHostHandle> {
  const version = ++generation;
  const withdrawal = active?.dispose();
  void withdrawal?.catch(() => {});
  const opening = setupQueue.then(async () => {
    await withdrawal;
    return openCurrent(input, version);
  });
  setupQueue = opening.then(() => {}, () => {});
  return opening;
}

async function openCurrent(input: BrowserThreadHostInput, version: number): Promise<BrowserThreadHostHandle> {
  const checkInput = () => {
    if (version !== generation || input.signal.aborted || !input.scopeKey
      || !Number.isFinite(Date.parse(input.authorizationExpiresAt))
      || Date.parse(input.authorizationExpiresAt) <= Date.now()) throw denied();
  };
  checkInput();
  // Unique lifetime suffix fences an old finalizer even when the same detail scope is opened again.
  const data = createBrowserDataBoundary(window.sessionStorage, `${input.scopeKey}:${crypto.randomUUID()}`);
  data.prepare(); // Cold-start and prior-account cleanup must succeed before any credential is spent.
  const scope = await Effect.runPromise(Scope.make());
  const controller = new AbortController();
  let credential: ConnectionCredential | undefined;
  let deadline = Date.parse(input.authorizationExpiresAt);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  let retired = false;
  const closed = Promise.withResolvers<void>();
  const current = () => !retired && version === generation && !input.signal.aborted && Date.now() < deadline;
  const dispose = () => {
    retired = true;
    closed.resolve();
    credential = undefined;
    data.retire();
    controller.abort();
    clearTimeout(timer);
    input.signal.removeEventListener('abort', onAbort);
    closing ??= Effect.runPromise(Scope.close(scope, Exit.void));
    return closing.finally(() => data.clear());
  };
  const onAbort = () => { void dispose().catch(() => { /* Persistent keys remain for the next cleanup retry. */ }); };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (Date.now() >= deadline) onAbort();
      else arm();
    }, Math.min(2_147_483_647, Math.max(1, deadline - Date.now())));
  };
  active = { dispose };
  input.signal.addEventListener('abort', onAbort, { once: true });
  const connectionId = `nessie-detail:${crypto.randomUUID()}`;
  const credentialId = credentialConnectionId(connectionId);
  const blocked = () => Effect.fail(new ConnectionBlockedError({ reason: 'unsupported',
    detail: 'This detail connection has no credential mutation capability.' }));
  const credentials = ConnectionCredentialStore.of({
    get: key => Effect.sync(() => current() && key === credentialId ? Option.fromNullishOr(credential) : Option.none()),
    put: blocked,
    remove: key => Effect.sync(() => { if (key === credentialId) credential = undefined; }),
  });
  const services = Layer.mergeAll(browserHostDriver, Bounded.layer, History.layer).pipe(Layer.provideMerge(
    Layer.mergeAll(browserHostPlatform(), Layer.succeed(ConnectionCredentialStore, credentials),
      Layer.succeed(Persistence.EnvironmentCacheStore,
        makeBrowserThreadCache(data, input.connection.environmentId, input.threadId))),
  ));
  try {
    checkInput();
    arm();
    const context = await Effect.runPromise(Layer.build(services).pipe(Scope.provide(scope)),
      { signal: controller.signal });
    const setup = Effect.gen(function* () {
      const connection = input.connection;
      if (!current() || !connection.credential || !Number.isFinite(Date.parse(connection.expiresAt))
        || Date.parse(connection.expiresAt) <= Date.now()) return yield* Effect.fail(denied());
      const httpBaseUrl = normalizeHttpBaseUrl(connection.endpoint.httpBaseUrl);
      const wsBaseUrl = environmentWebSocketUrl(httpBaseUrl, connection.endpoint.wsBaseUrl);
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl });
      if (descriptor.environmentId !== connection.environmentId) return yield* Effect.fail(denied());
      const incompatible = orchestrationProtocolCompatibilityError(descriptor);
      if (incompatible !== null) return yield* Effect.fail(incompatible);
      if (!current()) return yield* Effect.fail(denied());
      const issuedAt = Date.now();
      const access = yield* bootstrapRemoteBearerSession({ httpBaseUrl, credential: connection.credential });
      const accessDeadline = issuedAt + access.expires_in * 1_000;
      if (!current() || access.token_type !== 'Bearer' || !Number.isFinite(accessDeadline)
        || accessDeadline <= Date.now()) return yield* Effect.fail(denied());
      deadline = Math.min(deadline, accessDeadline);
      arm();
      credential = new BearerConnectionCredential({ token: access.access_token });
      const target = new BearerConnectionTarget({ connectionId, environmentId: connection.environmentId,
        label: descriptor.label });
      const registration = new BearerConnectionRegistration({ target, credential,
        profile: new BearerConnectionProfile({ connectionId, environmentId: target.environmentId,
          label: target.label, httpBaseUrl, wsBaseUrl }) });
      const supervisor = yield* Supervisor.make(connectionRegistrationCatalogEntry(registration));
      yield* SubscriptionRef.changes(supervisor.state).pipe(Stream.runForEach(value => Effect.sync(() => {
        if (value.phase === 'blocked') onAbort();
      })), Effect.forkScoped);
      const state = yield* Threads.makeEnvironmentThreadState(input.threadId).pipe(
        Effect.provideService(Supervisor.EnvironmentSupervisor, supervisor));
      yield* SubscriptionRef.changes(state).pipe(Stream.runForEach(value => Effect.sync(() => {
        if (current()) input.onState(value);
      })), Effect.forkScoped);
      yield* supervisor.connect;
      return supervisor;
    });
    const supervisor = await Effect.runPromise(setup.pipe(Effect.provide(context), Scope.provide(scope)),
      { signal: controller.signal });
    if (!current()) throw denied();
    const history = Context.get(context, History.ThreadHistoryController);
    const run = async <A, E>(effect: Effect.Effect<A, E>, signal = input.signal) => {
      if (!current() || signal.aborted) throw denied();
      const value = await Effect.runPromise(effect.pipe(Effect.tapError(error => Effect.sync(() => {
        if (Schema.is(EnvironmentAuthInvalidError)(error) || Schema.is(EnvironmentScopeRequiredError)(error)
          || Schema.is(EnvironmentOperationForbiddenError)(error)) onAbort();
      }))), { signal: AbortSignal.any([controller.signal, signal]) });
      if (!current() || signal.aborted) throw denied();
      return value;
    };
    return {
      closed: closed.promise,
      loadEarlier: (throughEntryId, workAnchorId) => run(history.loadEarlier(input.connection.environmentId,
        input.threadId, throughEntryId, workAnchorId)),
      readItem: (item, signal) => {
        if (item.threadId !== input.threadId) return Promise.reject(denied());
        return run(request(ORCHESTRATION_V2_WS_METHODS.getTurnItem, item).pipe(
          Effect.provideService(Supervisor.EnvironmentSupervisor, supervisor)), signal);
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
