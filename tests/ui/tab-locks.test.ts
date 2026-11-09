import { expect, it, vi } from 'vitest';
import { createTabLocks, type RequestLock } from '../../src/ui/tab-locks';

function fakeRequest(): RequestLock {
  const held = new Set<string>();
  return async (name, options, callback) => {
    if (options.ifAvailable) return callback(held.has(name) ? null : { name });
    held.add(name);
    const result = callback({ name });
    Promise.resolve(result).finally(() => held.delete(name));
    return result;
  };
}

it('reports a game held by another tab as busy until that tab releases it', async () => {
  const request = fakeRequest();
  const first = createTabLocks(request)!;
  const second = createTabLocks(request)!;

  const release = first.hold('game-1');
  expect(await second.isBusy('game-1')).toBe(true);
  expect(await second.isBusy('game-2')).toBe(false);

  release();
  await vi.waitFor(async () => expect(await second.isBusy('game-1')).toBe(false));
});

it('does not treat its own held game as another tab', async () => {
  const locks = createTabLocks(fakeRequest())!;
  const release = locks.hold('game-1');
  expect(await locks.isBusy('game-1')).toBe(false);
  release();
});

it('is unavailable without the Web Locks API', () => {
  expect(createTabLocks(null)).toBeNull();
});
