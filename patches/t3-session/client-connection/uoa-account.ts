/** Client-only connection lifecycle. UOA admission and the executor directory remain host-owned. */
export interface UoaConnectionAccount {
  readonly subject: string;
  readonly organizationId: string;
  readonly teamId: string;
  /** Changes on sign-out/sign-in even when the same person returns. Never a token. */
  readonly sessionId: string;
  readonly expiresAt: number;
}

export interface UoaEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly endpoint: { readonly httpBaseUrl: string; readonly wsBaseUrl: string };
}

export interface UoaConnectionLease<Registration> {
  readonly registration: Registration;
  readonly expiresAt: number;
}

export class UoaConnectionDenied extends Error {
  constructor() { super('UOA_CONNECTION_DENIED'); }
}

export interface UoaConnectionPorts<Registration> {
  /** Existing client account/cache/outbox cleanup, including a persisted previous account on cold start.
   * Must finish before registration. A failed cleanup must remain retryable across app restarts.
   * This port does not admit an identity; the canonical server rechecks every operation.
   */
  readonly prepare: (account: UoaConnectionAccount, signal: AbortSignal) => Promise<void>;
  /** Complete owner-entitled selected-team set, including offline computers, in directory order. */
  readonly list: (account: UoaConnectionAccount, signal: AbortSignal) => Promise<ReadonlyArray<UoaEnvironment>>;
  /** Original descriptor/bootstrap codecs; never reads a Clerk token or starts a provider. */
  readonly authorize: (account: UoaConnectionAccount, environment: UoaEnvironment,
    signal: AbortSignal) => Promise<UoaConnectionLease<Registration>>;
  /** The original EnvironmentRegistry.reconcilePlatform; no alternate catalog or reducers. */
  readonly reconcile: (registrations: ReadonlyArray<Registration>) => Promise<void>;
  /** Sanitized category only; errors can contain credentials and must not enter logs. */
  readonly report: (category: 'directory' | 'authorization' | 'cleanup') => void;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delay: number) => () => void;
}

const accountKey = (account: UoaConnectionAccount) => JSON.stringify([
  account.subject, account.organizationId, account.teamId, account.sessionId,
]);
const environmentKey = (environment: UoaEnvironment) => JSON.stringify([
  environment.environmentId, environment.label, environment.endpoint.httpBaseUrl, environment.endpoint.wsBaseUrl,
]);

/** One instance per original client runtime. It owns only expiring connection credentials. */
export function createUoaConnectionAccount<Registration>(ports: UoaConnectionPorts<Registration>) {
  const now = ports.now ?? Date.now;
  const schedule = ports.schedule ?? ((callback, delay) => {
    const timer = setTimeout(callback, Math.min(delay, 2_147_483_647));
    return () => clearTimeout(timer);
  });
  let account: UoaConnectionAccount | null = null;
  let generation = 0;
  let request: AbortController | undefined;
  let cancelExpiry: (() => void) | undefined;
  let cancelRefresh: (() => void) | undefined;
  let queue = Promise.resolve();
  let disposed = false;
  let prepared = false;
  let leases: ReadonlyArray<{ environment: UoaEnvironment; lease: UoaConnectionLease<Registration> }> = [];

  const enqueue = (operation: () => Promise<void>) => {
    const result = queue.then(operation);
    queue = result.catch(() => { ports.report('cleanup'); });
    return result;
  };
  const valid = (version: number, selected: UoaConnectionAccount) => !disposed && version === generation
    && account !== null && accountKey(account) === accountKey(selected) && account.expiresAt > now();
  const stopTimers = () => {
    cancelExpiry?.();
    cancelRefresh?.();
    cancelExpiry = undefined;
    cancelRefresh = undefined;
  };
  const withdraw = () => {
    leases = [];
    // Always reconcile, including repeated null/empty updates, to retry failed persistent cleanup.
    return enqueue(() => ports.reconcile([]));
  };
  const armExpiry = () => {
    cancelExpiry?.();
    if (account === null) return;
    const deadline = Math.min(account.expiresAt, ...leases.map(({ lease }) => lease.expiresAt));
    cancelExpiry = schedule(() => {
      if (account === null || disposed) return;
      if (account.expiresAt <= now()) {
        void setAccount(null).catch(() => {});
        return;
      }
      const selected = account;
      const version = generation;
      // Remove only expired leases; offline is not absence or deletion.
      leases = leases.filter(({ lease }) => lease.expiresAt > now());
      void enqueue(async () => {
        if (valid(version, selected)) await ports.reconcile(leases.map(({ lease }) => lease.registration));
      }).catch(() => {});
      armExpiry();
    }, Math.max(1, deadline - now()));
  };

  const refresh = async (): Promise<void> => {
    if (disposed || account === null || !prepared) return;
    if (account.expiresAt <= now()) return setAccount(null);
    request?.abort();
    cancelRefresh?.();
    const controller = new AbortController();
    request = controller;
    const selected = account;
    const version = ++generation;
    const current = () => valid(version, selected) && !controller.signal.aborted;
    let category: 'directory' | 'authorization' = 'directory';
    try {
      const environments = await ports.list(selected, controller.signal);
      if (!current()) return;
      const ids = new Set<string>();
      for (const environment of environments) {
        if (!environment.environmentId || ids.has(environment.environmentId)) throw new UoaConnectionDenied();
        ids.add(environment.environmentId);
      }
      // Authoritative absence withdraws before potentially slow bootstrap calls.
      leases = environments.flatMap(environment => {
        const previous = leases.find(item => environmentKey(item.environment) === environmentKey(environment)
          && item.lease.expiresAt > now());
        return previous ? [previous] : [];
      });
      await enqueue(async () => {
        if (current()) await ports.reconcile(leases.map(({ lease }) => lease.registration));
      });
      if (!current()) return;
      category = 'authorization';
      const next: typeof leases[number][] = [];
      for (const environment of environments) {
        const previous = leases.find(item => environmentKey(item.environment) === environmentKey(environment)
          && item.lease.expiresAt > now() + 30_000);
        const lease = previous?.lease ?? await ports.authorize(selected, environment, controller.signal);
        if (!current()) return;
        if (!Number.isFinite(lease.expiresAt) || lease.expiresAt <= now()) throw new UoaConnectionDenied();
        next.push({ environment, lease: { ...lease, expiresAt: Math.min(selected.expiresAt, lease.expiresAt) } });
      }
      await enqueue(async () => {
        if (!current()) return;
        // Check expiry again after waiting behind any registry cleanup.
        if (next.some(({ lease }) => lease.expiresAt <= now())) throw new UoaConnectionDenied();
        await ports.reconcile(next.map(({ lease }) => lease.registration));
        if (current()) leases = next;
      });
      if (!current()) return;
      armExpiry();
      if (leases.length > 0) {
        const deadline = Math.min(selected.expiresAt, ...leases.map(({ lease }) => lease.expiresAt));
        cancelRefresh = schedule(() => { void refresh().catch(() => {}); }, Math.max(1_000, deadline - now() - 30_000));
      }
    } catch (error) {
      if (!current()) return;
      if (error instanceof UoaConnectionDenied) {
        await setAccount(null);
      } else {
        ports.report(category);
        armExpiry();
      }
    }
  };

  const setAccount = async (next: UoaConnectionAccount | null): Promise<void> => {
    if (disposed) return;
    // Never accept expired or structurally incomplete account state as authority.
    if (next !== null && (!Number.isFinite(next.expiresAt) || next.expiresAt <= now()
      || [next.subject, next.organizationId, next.teamId, next.sessionId].some(value => !value))) next = null;
    const changed = account === null || next === null || accountKey(account) !== accountKey(next);
    request?.abort();
    ++generation;
    stopTimers();
    account = next === null ? null : Object.freeze({ ...next });
    if (changed) prepared = false;
    const version = generation;
    if (changed) await withdraw();
    if (version !== generation || account === null) return;
    armExpiry();
    if (!prepared) {
      const selected = account;
      const controller = new AbortController();
      request = controller;
      try {
        await ports.prepare(selected, controller.signal);
      } catch (error) {
        if (valid(version, selected)) ports.report('cleanup');
        throw error;
      }
      if (!valid(version, selected) || controller.signal.aborted) return;
      prepared = true;
    }
    await refresh();
  };

  return {
    setAccount,
    /** Foreground, network-path and directory-change wakeups reuse this same operation. */
    refresh,
    async dispose() {
      disposed = true;
      account = null;
      ++generation;
      request?.abort();
      stopTimers();
      await withdraw();
    },
  };
}
