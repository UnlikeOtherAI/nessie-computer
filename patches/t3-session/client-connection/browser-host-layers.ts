import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Queue from 'effect/Queue';
import * as Stream from 'effect/Stream';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Socket from 'effect/socket/Socket';
import * as Driver from 't3-source:packages/client-runtime/src/connection/driver.ts';
import * as Resolver from 't3-source:packages/client-runtime/src/connection/resolver.ts';
import * as Authorization from 't3-source:packages/client-runtime/src/authorization/service.ts';
import * as Connectivity from 't3-source:packages/client-runtime/src/connection/connectivity.ts';
import * as Wakeups from 't3-source:packages/client-runtime/src/connection/wakeups.ts';
import * as Capabilities from 't3-source:packages/client-runtime/src/platform/capabilities.ts';
import * as RpcSession from 't3-source:packages/client-runtime/src/rpc/session.ts';

const events = <A>(target: EventTarget, names: ReadonlyArray<string>, value: () => A) => Stream.callback<A>(queue =>
  Effect.acquireRelease(Effect.sync(() => {
    const listener = () => Queue.offerUnsafe(queue, value());
    for (const name of names) target.addEventListener(name, listener);
    return listener;
  }), listener => Effect.sync(() => {
    for (const name of names) target.removeEventListener(name, listener);
  })).pipe(Effect.asVoid));

/** Browser primitives only. No Clerk, relay discovery, provider or server services. */
export const browserHostPlatform = () => Layer.mergeAll(
  FetchHttpClient.layer,
  Socket.layerWebSocketConstructorGlobal,
  Layer.succeed(Capabilities.ClientPresentation, { metadata: { label: 'Nessie' } }),
  Connectivity.layer({ status: Effect.sync(() => navigator.onLine ? 'online' : 'offline'),
    changes: events(window, ['online', 'offline'], () => navigator.onLine ? 'online' as const : 'offline' as const) }),
  Wakeups.layer({ changes: events(document, ['visibilitychange'], () => 'application-active' as const)
    .pipe(Stream.filter(() => document.visibilityState === 'visible')) }),
);

export const browserHostDriver = Driver.layer.pipe(
  Layer.provide(Layer.mergeAll(Resolver.layerBearer, RpcSession.layer({ providerCatalogsOnDemand: true }))),
  Layer.provideMerge(Authorization.layerBearer),
);
