import {
  EnvironmentAuthInvalidError, EnvironmentOperationForbiddenError, EnvironmentScopeRequiredError,
} from '@t3tools/contracts';
import { EnvironmentRegistry, type BearerConnectionRegistration } from '@t3tools/client-runtime/connection';
import * as Effect from 'effect/Effect';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as HttpClient from 'effect/http/HttpClient';

import { createUoaConnectionAccount, UoaConnectionDenied, type UoaConnectionPorts } from './uoa-account.ts';
import { authorizeUoaEnvironment, type UoaBootstrapPorts } from './uoa-bootstrap.ts';

export type UoaRuntimePorts = UoaBootstrapPorts & Pick<UoaConnectionPorts<BearerConnectionRegistration>,
  'prepare' | 'list' | 'report' | 'schedule'>;

/**
 * Acquire in the original connection runtime's scope, after its URL and registry patches.
 * The host binds UOA/directory operations only after T08/T09 integration. No service starts on import.
 */
export const makeUoaConnectionAccount = (ports: UoaRuntimePorts) => Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const http = yield* HttpClient.HttpClient;
  const service = createUoaConnectionAccount<BearerConnectionRegistration>({
    prepare: ports.prepare,
    list: ports.list,
    report: ports.report,
    now: ports.now,
    schedule: ports.schedule,
    reconcile: registrations => Effect.runPromise(registry.reconcilePlatform(registrations)),
    authorize: async (account, environment, signal) => {
      const result = await Effect.runPromise(authorizeUoaEnvironment(ports, account, environment, signal).pipe(
        Effect.provideService(HttpClient.HttpClient, http), Effect.result,
      ), { signal });
      if (Result.isSuccess(result)) return result.success;
      const failure = result.failure;
      if (Schema.is(EnvironmentAuthInvalidError)(failure) || Schema.is(EnvironmentScopeRequiredError)(failure)
        || Schema.is(EnvironmentOperationForbiddenError)(failure)) throw new UoaConnectionDenied();
      throw failure;
    },
  });
  yield* Effect.addFinalizer(() => Effect.promise(() => service.dispose()));
  return service;
});
