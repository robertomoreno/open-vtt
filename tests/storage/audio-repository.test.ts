import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { AUDIO_BYTES } from '../../src/network/limits';
import { createWorkspaceRepository } from '../../src/storage/workspace-repository';
import { createTestWorkspace, namedRuntime } from '../helpers/workspace';

const bytes = (n = 8) => Uint8Array.from({ length: n }, (_, i) => i).buffer;

it('stores, lists, reads, and removes per-game audio bytes', async () => {
  const repo = createWorkspaceRepository({ indexedDB: new IDBFactory(), dbName: randomUUID(), runtime: namedRuntime('a') });
  const gameId = 'game';
  expect(await repo.putAudio(gameId, 'a'.repeat(64), bytes())).toEqual({ ok: true });
  expect(await repo.hasAudio(gameId, 'a'.repeat(64))).toBe(true);
  expect(await repo.listAudio(gameId)).toEqual(['a'.repeat(64)]);
  expect(new Uint8Array((await repo.getAudio(gameId, 'a'.repeat(64)))!)).toEqual(new Uint8Array(bytes()));
  await repo.removeAudio(gameId, 'a'.repeat(64));
  expect(await repo.hasAudio(gameId, 'a'.repeat(64))).toBe(false);
  expect(await repo.getAudio(gameId, 'b'.repeat(64))).toBeNull();
});

it('rejects oversized audio and reports denied storage without throwing', async () => {
  const repo = createWorkspaceRepository({ indexedDB: new IDBFactory(), dbName: randomUUID(), runtime: namedRuntime('a') });
  expect(await repo.putAudio('game', 'a'.repeat(64), new ArrayBuffer(AUDIO_BYTES + 1))).toMatchObject({ ok: false });
  const denied = createWorkspaceRepository({ indexedDB: { open() { throw new Error('denied'); } } as unknown as IDBFactory, dbName: randomUUID(), runtime: namedRuntime('d') });
  expect(await denied.putAudio('game', 'a'.repeat(64), bytes())).toMatchObject({ ok: false });
  expect(await denied.getAudio('game', 'a'.repeat(64))).toBeNull();
  expect(await denied.listAudio('game')).toEqual([]);
});

it('deletes every audio record for a game and cascades with game deletion', async () => {
  const repo = createWorkspaceRepository({ indexedDB: new IDBFactory(), dbName: randomUUID(), runtime: namedRuntime('a') });
  const snapshot = createTestWorkspace('a').getSnapshot();
  await repo.save(snapshot, 0);
  await repo.putAudio(snapshot.game.id, 'a'.repeat(64), bytes());
  await repo.putAudio(snapshot.game.id, 'b'.repeat(64), bytes());
  await repo.putAudio('other', 'c'.repeat(64), bytes());
  await repo.removeGameAudio(snapshot.game.id);
  expect(await repo.listAudio(snapshot.game.id)).toEqual([]);
  expect(await repo.listAudio('other')).toEqual(['c'.repeat(64)]);
  await repo.putAudio(snapshot.game.id, 'a'.repeat(64), bytes());
  await repo.remove(snapshot.game.id);
  expect(await repo.listAudio(snapshot.game.id)).toEqual([]);
});

it('keeps working after a version-1 database is upgraded', async () => {
  const indexedDB = new IDBFactory(), dbName = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('games', { keyPath: 'id' });
      request.result.createObjectStore('recovery', { keyPath: 'id' });
    };
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
  const repo = createWorkspaceRepository({ indexedDB, dbName, runtime: namedRuntime('a') });
  expect(await repo.putAudio('game', 'a'.repeat(64), bytes())).toEqual({ ok: true });
  expect(await repo.hasAudio('game', 'a'.repeat(64))).toBe(true);
});
