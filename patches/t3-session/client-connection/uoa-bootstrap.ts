import type { AuthClientPresentationMetadata } from '@t3tools/contracts';
import {
  BearerConnectionCredential, BearerConnectionProfile, BearerConnectionRegistration, BearerConnectionTarget,
  orchestrationProtocolCompatibilityError,
} from '@t3tools/client-runtime/connection';
import { bootstrapRemoteBearerSession } from '@t3tools/client-runtime/authorization';
import {
  environmentWebSocketUrl, fetchRemoteEnvironmentDescriptor, normalizeHttpBaseUrl,
} from '@t3tools/client-runtime/environment';
import * as Effect from 'effect/Effect';

import type { UoaConnectionAccount, UoaEnvironment } from './uoa-account.ts';
import { UoaConnectionDenied } from './uoa-account.ts';

/** Decoded canonical connect result; credential is one-use bootstrap material, never an account token. */
export interface UoaEnvironmentConnect {
  readonly environmentId: string;
  readonly endpoint: { readonly httpBaseUrl: string; readonly wsBaseUrl: string };
  readonly credential: string;
  readonly expiresAt: string;
}

export interface UoaBootstrapPorts {
  readonly apiOrigin: string;
  readonly connect: (account: UoaConnectionAccount, environmentId: string,
    signal: AbortSignal) => Promise<UoaEnvironmentConnect>;
  readonly clientMetadata?: AuthClientPresentationMetadata;
  readonly now?: () => number;
}

/** Run in the original client's HTTP layer. There is no network client or alternate OAuth implementation here. */
export const authorizeUoaEnvironment = (ports: UoaBootstrapPorts, account: UoaConnectionAccount,
  environment: UoaEnvironment, signal: AbortSignal) => Effect.gen(function* () {
  const now = ports.now ?? Date.now;
  const checkCurrent = () => {
    if (signal.aborted || account.expiresAt <= now()) throw new UoaConnectionDenied();
  };
  const validateEndpoint = (endpoint: UoaEnvironment['endpoint']) => {
    const httpBaseUrl = normalizeHttpBaseUrl(endpoint.httpBaseUrl);
    const url = new URL(httpBaseUrl);
    const api = new URL(ports.apiOrigin);
    if (api.protocol !== 'https:' || url.origin !== api.origin || url.protocol !== 'https:'
      || !/^\/t3\/environments\/[^/]+\/$/u.test(url.pathname)) throw new UoaConnectionDenied();
    return { httpBaseUrl, wsBaseUrl: environmentWebSocketUrl(httpBaseUrl, endpoint.wsBaseUrl) };
  };
  const endpoint = yield* Effect.try({ try: () => { checkCurrent(); return validateEndpoint(environment.endpoint); },
    catch: () => new UoaConnectionDenied() });
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl: endpoint.httpBaseUrl });
  if (descriptor.environmentId !== environment.environmentId) return yield* Effect.fail(new UoaConnectionDenied());
  const incompatible = orchestrationProtocolCompatibilityError(descriptor);
  if (incompatible !== null) return yield* Effect.fail(incompatible);
  yield* Effect.try({ try: checkCurrent, catch: () => new UoaConnectionDenied() });
  // Mint only after checking the actual mounted descriptor. Never spend a credential at a different endpoint.
  const connected = yield* Effect.tryPromise({
    try: () => ports.connect(account, environment.environmentId, signal),
    catch: (error) => error,
  });
  yield* Effect.try({
    try: () => {
      checkCurrent();
      const actual = validateEndpoint(connected.endpoint);
      if (connected.environmentId !== environment.environmentId || !connected.credential
        || actual.httpBaseUrl !== endpoint.httpBaseUrl || actual.wsBaseUrl !== endpoint.wsBaseUrl
        || !Number.isFinite(Date.parse(connected.expiresAt)) || Date.parse(connected.expiresAt) <= now()) {
        throw new UoaConnectionDenied();
      }
    }, catch: () => new UoaConnectionDenied(),
  });
  const issuedAt = now();
  const access = yield* bootstrapRemoteBearerSession({ httpBaseUrl: endpoint.httpBaseUrl,
    credential: connected.credential, clientMetadata: ports.clientMetadata });
  const expiresAt = Math.min(account.expiresAt, issuedAt + access.expires_in * 1_000);
  yield* Effect.try({ try: () => {
    checkCurrent();
    if (access.token_type !== 'Bearer' || !Number.isFinite(expiresAt) || expiresAt <= now()) {
      throw new UoaConnectionDenied();
    }
  }, catch: () => new UoaConnectionDenied() });
  // Scope the credential storage key without changing the original environment identity.
  const connectionId = `uoa:${JSON.stringify([account.subject, account.organizationId, account.teamId,
    account.sessionId, environment.environmentId, endpoint.httpBaseUrl])}`;
  const target = new BearerConnectionTarget({ connectionId,
    environmentId: descriptor.environmentId, label: environment.label });
  return {
    registration: new BearerConnectionRegistration({ target,
      profile: new BearerConnectionProfile({ connectionId, environmentId: target.environmentId,
        label: target.label, ...endpoint }),
      credential: new BearerConnectionCredential({ token: access.access_token }),
    }),
    expiresAt,
  };
});
