import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { browserWorkspaceRepository, createWorkspaceRepository } from '../../src/storage/workspace-repository';
import { createTestWorkspace, namedRuntime, fixtureRoster } from '../helpers/workspace';
import { memoryStorage } from '../helpers/storage';
import type { Game } from '../../src/game/types';

function deniedFactory(): IDBFactory {
  return { open() { throw new Error('IndexedDB denied'); } } as unknown as IDBFactory;
}
function blockedFactory(): IDBFactory {
  return {
    open() {
      const request: { onblocked?: (() => void) | null } = {};
      setTimeout(() => request.onblocked?.(), 0);
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}
function lateSuccessFactory(): { indexedDB: IDBFactory; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  const handle = { close };
  const indexedDB = {
    open() {
      const request: { onblocked?: (() => void) | null; onsuccess?: (() => void) | null; onupgradeneeded?: (() => void) | null; onerror?: (() => void) | null; result?: unknown } = {};
      setTimeout(() => request.onblocked?.(), 0);
      setTimeout(() => { request.result = handle; request.onsuccess?.(); }, 2000);
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
  return { indexedDB, close };
}
function delayedSuccessFactory(): { indexedDB: IDBFactory; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  const handle = { close };
  const indexedDB = {
    open() {
      const request: { onsuccess?: (() => void) | null; result?: unknown } = {};
      setTimeout(() => { request.result = handle; request.onsuccess?.(); }, 0);
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
  return { indexedDB, close };
}
async function putRawRecord(indexedDB: IDBFactory, dbName: string, record: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(dbName, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('games')) db.createObjectStore('games', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('recovery')) db.createObjectStore('recovery', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'key' }).createIndex('gameId', 'gameId');
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('games', 'readwrite');
      tx.objectStore('games').put(record as { id: string });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error ?? new Error('put failed')); };
    };
    request.onerror = () => reject(request.error ?? new Error('open failed'));
  });
}
async function bumpVersion(indexedDB: IDBFactory, dbName: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.open(dbName, 3);
    request.onupgradeneeded = () => {};
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => resolve();
  });
}
const legacyGame = (): Game => ({ ...fixtureRoster(), id: 'legacy' });

it('rejects a stale second-tab save without overwriting newer history', async () => {
  const indexedDB = new IDBFactory(), dbName = randomUUID();
  const one = createWorkspaceRepository({ indexedDB, dbName, runtime: namedRuntime('one') });
  const two = createWorkspaceRepository({ indexedDB, dbName, runtime: namedRuntime('two') });
  const initial = createTestWorkspace('seed').getSnapshot();
  expect(await one.save(initial, 0)).toEqual({ ok: true, version: 1 });
  const a = await one.load(initial.game.id), b = await two.load(initial.game.id);
  expect(await one.save(a.snapshot!, a.version)).toEqual({ ok: true, version: 2 });
  expect(await two.save(b.snapshot!, b.version)).toMatchObject({ ok: false, reason: 'stale' });
  expect((await two.load(initial.game.id)).version).toBe(2);
});

it('retains the prior snapshot and history when a save fails validation', async () => {
  const indexedDB = new IDBFactory();
  const repo = createWorkspaceRepository({ indexedDB, dbName: randomUUID(), runtime: namedRuntime('t') });
  const initial = createTestWorkspace('seed').getSnapshot();
  expect(await repo.save(initial, 0)).toEqual({ ok: true, version: 1 });
  const tampered = { ...initial, game: { ...initial.game, name: 'Tampered' } };
  expect(await repo.save(tampered, 1)).toMatchObject({ ok: false, reason: 'storage' });
  const loaded = await repo.load(initial.game.id);
  expect(loaded.version).toBe(1);
  expect(loaded.snapshot).toEqual(initial);
});

it('skips a corrupt record with a warning while other games still list and load', async () => {
  const indexedDB = new IDBFactory(), dbName = randomUUID();
  const repo = createWorkspaceRepository({ indexedDB, dbName, runtime: namedRuntime('t') });
  const good = createTestWorkspace('good').getSnapshot();
  expect(await repo.save(good, 0)).toEqual({ ok: true, version: 1 });
  await putRawRecord(indexedDB, dbName, { id: 'bad', version: 1, snapshot: { game: {}, history: new Uint8Array() } });
  const list = await repo.list();
  expect(list.games.map(g => g.id)).toEqual(['game']);
  expect(list.warnings).toHaveLength(1);
  expect((await repo.load('bad')).snapshot).toBeNull();
  expect((await repo.load(good.game.id)).snapshot).toEqual(good);
});

it('replaces only that game’s prior recovery slot', async () => {
  const indexedDB = new IDBFactory();
  const repo = createWorkspaceRepository({ indexedDB, dbName: randomUUID(), runtime: namedRuntime('r') });
  const workspace = createTestWorkspace('r');
  const before = workspace.getSnapshot();
  workspace.applyLocal({ type: 'set-game-name', name: 'After edit' });
  const after = workspace.getSnapshot();
  expect(await repo.saveRecovery(before)).toEqual({ ok: true });
  expect(await repo.saveRecovery(after)).toEqual({ ok: true });
  expect((await repo.loadRecovery('game'))?.game.name).toBe('After edit');
  const other = createTestWorkspace('other', { ...fixtureRoster(), id: 'other' });
  expect(await repo.saveRecovery(other.getSnapshot())).toEqual({ ok: true });
  expect((await repo.loadRecovery('other'))?.game.id).toBe('other');
  expect((await repo.loadRecovery('game'))?.game.name).toBe('After edit');
});

it('migrates a legacy game on load and leaves the legacy record untouched', async () => {
  const indexedDB = new IDBFactory();
  const storage = memoryStorage();
  storage.setItem('gather:game:legacy', JSON.stringify(legacyGame()));
  const repo = createWorkspaceRepository({ indexedDB, dbName: randomUUID(), storage, runtime: namedRuntime('m') });
  const loaded = await repo.load('legacy');
  expect(loaded.snapshot).not.toBeNull();
  expect(loaded.snapshot!.game).toEqual(legacyGame());
  expect(loaded.version).toBe(1);
  expect(loaded.warnings).toHaveLength(0);
  expect(storage.getItem('gather:game:legacy')).toBe(JSON.stringify(legacyGame()));
});

it('removes a game with its history, recovery copy, legacy save, and identity hint only', async () => {
  const indexedDB = new IDBFactory();
  const storage = memoryStorage();
  const repo = createWorkspaceRepository({ indexedDB, dbName: randomUUID(), storage, runtime: namedRuntime('d') });
  const deleted = createTestWorkspace('deleted').getSnapshot();
  const kept = createTestWorkspace('kept', { ...fixtureRoster(), id: 'kept' }).getSnapshot();
  expect(await repo.save(deleted, 0)).toEqual({ ok: true, version: 1 });
  expect(await repo.save(kept, 0)).toEqual({ ok: true, version: 1 });
  expect(await repo.saveRecovery(deleted)).toEqual({ ok: true });
  expect(await repo.saveRecovery(kept)).toEqual({ ok: true });
  storage.setItem('gather:game:' + deleted.game.id, JSON.stringify(deleted.game));
  storage.setItem('gather:identity:' + deleted.game.id, 'alex');
  storage.setItem('gather:game:' + kept.game.id, JSON.stringify(kept.game));
  storage.setItem('gather:identity:' + kept.game.id, 'bea');

  expect(await repo.remove(deleted.game.id)).toEqual({ ok: true });

  expect((await repo.list()).games.map(game => game.id)).toEqual([kept.game.id]);
  expect((await repo.load(deleted.game.id)).snapshot).toBeNull();
  expect(await repo.loadRecovery(deleted.game.id)).toBeNull();
  expect(storage.getItem('gather:game:' + deleted.game.id)).toBeNull();
  expect(storage.getItem('gather:identity:' + deleted.game.id)).toBeNull();
  expect((await repo.load(kept.game.id)).snapshot).toEqual(kept);
  expect(await repo.loadRecovery(kept.game.id)).toEqual(kept);
  expect(storage.getItem('gather:game:' + kept.game.id)).toBe(JSON.stringify(kept.game));
  expect(repo.rememberedPlayer(kept.game.id)).toBe('bea');
});

it('removes a legacy-only save when IndexedDB is unavailable', async () => {
  const storage = memoryStorage();
  storage.setItem('gather:game:legacy', JSON.stringify(legacyGame()));
  storage.setItem('gather:identity:legacy', 'alex');
  const repo = createWorkspaceRepository({ indexedDB: deniedFactory(), dbName: randomUUID(), storage, runtime: namedRuntime('d') });
  expect(await repo.remove('legacy')).toEqual({ ok: true });
  expect(storage.getItem('gather:game:legacy')).toBeNull();
  expect(storage.getItem('gather:identity:legacy')).toBeNull();
});

it('returns an in-memory snapshot with a warning when migration cannot persist', async () => {
  const storage = memoryStorage();
  storage.setItem('gather:game:legacy', JSON.stringify(legacyGame()));
  const repo = createWorkspaceRepository({ indexedDB: deniedFactory(), dbName: randomUUID(), storage, runtime: namedRuntime('m') });
  const loaded = await repo.load('legacy');
  expect(loaded.snapshot).not.toBeNull();
  expect(loaded.snapshot!.game).toEqual(legacyGame());
  expect(loaded.version).toBe(0);
  expect(loaded.warnings.length).toBeGreaterThan(0);
  expect(storage.getItem('gather:game:legacy')).toBe(JSON.stringify(legacyGame()));
});

it('settles a denied database handle with warnings instead of hanging', async () => {
  const repo = createWorkspaceRepository({ indexedDB: deniedFactory(), dbName: randomUUID(), runtime: namedRuntime('d') });
  expect((await repo.list()).games).toEqual([]);
  expect((await repo.list()).warnings.length).toBeGreaterThan(0);
  expect(await repo.save(createTestWorkspace('d').getSnapshot(), 0)).toMatchObject({ ok: false, reason: 'storage' });
  const loaded = await repo.load('x');
  expect(loaded.snapshot).toBeNull();
  expect(loaded.version).toBe(0);
  expect(loaded.warnings.length).toBeGreaterThan(0);
});

it('settles a blocked open as unavailable instead of hanging', async () => {
  vi.useFakeTimers();
  try {
    const repo = createWorkspaceRepository({ indexedDB: blockedFactory(), dbName: randomUUID(), runtime: namedRuntime('b') });
    const pending = repo.list();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.games).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  } finally {
    vi.useRealTimers();
  }
});

it('closes on versionchange and later operations settle with warnings', async () => {
  const indexedDB = new IDBFactory(), dbName = randomUUID();
  const repo = createWorkspaceRepository({ indexedDB, dbName, runtime: namedRuntime('v') });
  const initial = createTestWorkspace('v').getSnapshot();
  expect(await repo.save(initial, 0)).toEqual({ ok: true, version: 1 });
  await bumpVersion(indexedDB, dbName);
  const loaded = await repo.load(initial.game.id);
  expect(loaded.snapshot).toBeNull();
  expect(loaded.version).toBe(0);
  expect(loaded.warnings.length).toBeGreaterThan(0);
});

it('isolates identity hints from a throwing storage while IndexedDB still works', async () => {
  const indexedDB = new IDBFactory();
  const throwing = new Proxy({} as Storage, { get() { throw new Error('Storage denied'); } });
  const repo = createWorkspaceRepository({ indexedDB, dbName: randomUUID(), storage: throwing, runtime: namedRuntime('i') });
  expect(repo.rememberPlayer('game', 'alex')).toMatchObject({ ok: false });
  expect(repo.rememberedPlayer('game')).toBeNull();
  const initial = createTestWorkspace('i').getSnapshot();
  expect(await repo.save(initial, 0)).toEqual({ ok: true, version: 1 });
  expect((await repo.load(initial.game.id)).snapshot).toEqual(initial);
});

it('round trips a workspace atomically with its history', async () => {
  const indexedDB = new IDBFactory();
  const repo = createWorkspaceRepository({ indexedDB, dbName: randomUUID(), runtime: namedRuntime('rt') });
  const initial = createTestWorkspace('seed').getSnapshot();
  expect(await repo.save(initial, 0)).toEqual({ ok: true, version: 1 });
  const loaded = await repo.load(initial.game.id);
  expect(loaded.version).toBe(1);
  expect(loaded.snapshot).toEqual(initial);
  expect((await repo.list()).games).toEqual([initial.game]);
});

it('close() stops further operations without hanging', async () => {
  const indexedDB = new IDBFactory();
  const repo = createWorkspaceRepository({ indexedDB, dbName: randomUUID(), runtime: namedRuntime('c') });
  const initial = createTestWorkspace('c').getSnapshot();
  expect(await repo.save(initial, 0)).toEqual({ ok: true, version: 1 });
  repo.close();
  expect((await repo.list()).games).toEqual([]);
  expect((await repo.save(initial, 1)).ok).toBe(false);
  expect((await repo.load(initial.game.id)).snapshot).toBeNull();
});

it('browserWorkspaceRepository settles when browser storage globals are absent', async () => {
  const repo = browserWorkspaceRepository(namedRuntime('bw'));
  expect((await repo.list()).games).toEqual([]);
  expect((await repo.save(createTestWorkspace('bw').getSnapshot(), 0)).ok).toBe(false);
});

it('closes a database handle that succeeds after the open settled as blocked', async () => {
  vi.useFakeTimers();
  try {
    const { indexedDB, close } = lateSuccessFactory();
    const repo = createWorkspaceRepository({ indexedDB, dbName: randomUUID(), runtime: namedRuntime('l') });
    const pending = repo.list();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).games).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('closes a database handle that succeeds after close()', async () => {
  vi.useFakeTimers();
  try {
    const { indexedDB, close } = delayedSuccessFactory();
    const repo = createWorkspaceRepository({ indexedDB, dbName: randomUUID(), runtime: namedRuntime('l') });
    const pending = repo.list();
    repo.close();
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).games).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('allows re-saving over a corrupt record instead of returning stale forever', async () => {
  const indexedDB = new IDBFactory(), dbName = randomUUID();
  const repo = createWorkspaceRepository({ indexedDB, dbName, runtime: namedRuntime('t') });
  const snapshot = createTestWorkspace('seed').getSnapshot();
  await putRawRecord(indexedDB, dbName, { id: snapshot.game.id, version: 1, snapshot: { game: {}, history: new Uint8Array() } });
  expect(await repo.load(snapshot.game.id)).toMatchObject({ snapshot: null, version: 0 });
  expect(await repo.save(snapshot, 0)).toEqual({ ok: true, version: 1 });
  expect((await repo.load(snapshot.game.id)).snapshot).toEqual(snapshot);
});

it('recovers a corrupt durable record from intact legacy bytes', async () => {
  const indexedDB = new IDBFactory(), dbName = randomUUID();
  const storage = memoryStorage();
  storage.setItem('gather:game:legacy', JSON.stringify(legacyGame()));
  const repo = createWorkspaceRepository({ indexedDB, dbName, storage, runtime: namedRuntime('m') });
  await putRawRecord(indexedDB, dbName, { id: 'legacy', version: 1, snapshot: { game: {}, history: new Uint8Array() } });
  const loaded = await repo.load('legacy');
  expect(loaded.snapshot).not.toBeNull();
  expect(loaded.snapshot!.game).toEqual(legacyGame());
  expect(loaded.version).toBe(1);
});
