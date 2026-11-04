// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { mountApp } from '../../src/ui/app';
import { createWorkspaceRepository } from '../../src/storage/workspace-repository';
import { IDBFactory } from 'fake-indexeddb';
import { runtime } from '../helpers/game';
import { randomUUID } from 'node:crypto';
import { roomLink, createRoomLink } from '../../src/network/room-link';

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