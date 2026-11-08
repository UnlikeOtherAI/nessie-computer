/** Only this browser host's data. Never clear another application's storage. */
export const browserDataPrefix = 'nessie:t3-detail:v1:';

export interface BrowserDataStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** No credentials are accepted here. Original cache codecs supply the serialized values. */
export function createBrowserDataBoundary(storage: BrowserDataStorage, scopeKey: string) {
  let active = false;
  const prefix = `${browserDataPrefix}${encodeURIComponent(scopeKey)}:`;
  const purge = (selectedPrefix: string) => {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(selectedPrefix)) keys.push(key);
    }
    // Try every owned key even if one deletion fails. Remaining keys are the durable retry record.
    const failures: unknown[] = [];
    for (const key of keys) try { storage.removeItem(key); } catch (error) { failures.push(error); }
    if (failures.length) throw new Error('T3_BROWSER_DATA_CLEANUP_FAILED');
  };
  const check = () => { if (!active) throw new Error('T3_BROWSER_DATA_RETIRED'); };
  return {
    prepare: () => { active = false; purge(browserDataPrefix); active = true; },
    read: (key: string) => { check(); return storage.getItem(prefix + key); },
    write: (key: string, value: string) => { check(); storage.setItem(prefix + key, value); },
    remove: (key: string) => { check(); storage.removeItem(prefix + key); },
    // Retire synchronously before any asynchronous scope finalizer can save a cached projection.
    retire: () => { active = false; },
    clear: () => { active = false; purge(prefix); },
  };
}
export type BrowserDataBoundary = ReturnType<typeof createBrowserDataBoundary>;
