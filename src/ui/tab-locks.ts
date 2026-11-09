export type TabLocks = {
  hold(gameId: string): () => void;
  isBusy(gameId: string): Promise<boolean>;
};

export type RequestLock = (
  name: string,
  options: { ifAvailable?: boolean },
  callback: (lock: unknown) => unknown,
) => Promise<unknown>;

const PREFIX = 'gather:session:';

function browserRequest(): RequestLock | null {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) return null;
  return (name, options, callback) => locks.request(name, options, callback as (lock: Lock | null) => unknown);
}

export function browserTabLocks(): TabLocks | null {
  return createTabLocks(browserRequest());
}

export function createTabLocks(request: RequestLock | null): TabLocks | null {
  if (!request) return null;
  const held = new Map<string, () => void>();
  return {
    hold(gameId) {
      const existing = held.get(gameId);
      if (existing) return existing;
      let releaseBarrier = () => {};
      const barrier = new Promise<void>(resolve => { releaseBarrier = resolve; });
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        held.delete(gameId);
        releaseBarrier();
      };
      held.set(gameId, release);
      request(PREFIX + gameId, {}, async () => { await barrier; }).catch(() => {});
      return release;
    },
    async isBusy(gameId) {
      if (held.has(gameId)) return false;
      try {
        return (await request(PREFIX + gameId, { ifAvailable: true }, lock => lock)) === null;
      } catch {
        return false;
      }
    },
  };
}
