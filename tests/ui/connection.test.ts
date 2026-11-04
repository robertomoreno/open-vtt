// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { mountApp } from '../../src/ui/app';
import { createWorkspaceRepository } from '../../src/storage/workspace-repository';
import { IDBFactory } from 'fake-indexeddb';
import { runtime } from '../helpers/game';
import { randomUUID } from 'node:crypto';
import { roomLink, createRoomLink } from '../../src/network/room-link';
import { createWorkspace } from '../../src/game/workspace';
import { validateGame } from '../../src/game/validation';

beforeEach(() => { document.body.innerHTML = '<main id="root"></main>'; });
const root = () => document.querySelector<HTMLElement>('#root')!;

it('consumes a room fragment without starting discovery', async () => {
  const link = roomLink(createRoomLink('game'), location.href);
  history.replaceState(null, '', link);
  const app = mountApp(root(), { repository: createWorkspaceRepository({ indexedDB: new IDBFactory(), dbName: randomUUID(), runtime: runtime() }), runtime: runtime() });
  await vi.waitFor(() => expect(location.hash).toBe(''));
  await vi.waitFor(() => expect(document.querySelector('#new-game')).not.toBeNull());
  app.destroy();
});

it('same-game incoming link preserves local fork/recovery', async () => {
  const repo = createWorkspaceRepository({ indexedDB: new IDBFactory(), dbName: randomUUID(), runtime: runtime() });
  const game = validateGame({ schemaVersion: 1, id: 'game', name: 'Local Fork', createdAt: '2026-10-27T12:00:00.000Z', updatedAt: '2026-10-27T12:00:00.000Z', revision: 0, players: [{ id: 'alex', name: 'Alex', role: 'gm' }], rolls: [] });
  const workspace = createWorkspace(game, runtime());
  const snapshot = workspace.getSnapshot();
  workspace.destroy();
  await repo.save(snapshot, 0);
  const link = roomLink(createRoomLink('game'), location.href);
  history.replaceState(null, '', link);
  const app = mountApp(root(), { repository: repo, runtime: runtime() });
  await vi.waitFor(() => expect(location.hash).toBe(''));
  await vi.waitFor(() => expect(root().textContent).toContain('Local Fork'));
  app.destroy();
});
