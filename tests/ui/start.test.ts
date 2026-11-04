// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { mountApp } from '../../src/ui/app';
import { createWorkspaceRepository } from '../../src/storage/workspace-repository';
import { IDBFactory } from 'fake-indexeddb';
import { memoryStorage } from '../helpers/storage';
import { fixtureGame, runtime } from '../helpers/game';
import { randomUUID } from 'node:crypto';

beforeEach(() => { document.body.innerHTML = '<main id="root"></main>'; });

const root = () => document.querySelector<HTMLElement>('#root')!;

it('creates a locally saved game and rolls without peers', async () => {
  const indexedDB = new IDBFactory();
  const repo = createWorkspaceRepository({ indexedDB, dbName: randomUUID(), runtime: runtime() });
  const app = mountApp(root(), { repository: repo, runtime: runtime() });
  await vi.waitFor(() => expect(root().textContent).toContain('A fresh beginning'));
  (document.querySelector<HTMLInputElement>('#game-name')!).value = 'Lantern';
  (document.querySelector<HTMLInputElement>('#creator-name')!).value = 'Alex';
  document.querySelector<HTMLFormElement>('#new-game')!.requestSubmit();
  await vi.waitFor(() => expect(root().textContent).toContain('Lantern'));
  document.querySelector<HTMLButtonElement>('#roll')!.click();
  await vi.waitFor(async () => expect((await repo.list()).games.length).toBe(1));
  app.destroy();
});

it('shows environment message when creation is unavailable', async () => {
  const app = mountApp(root(), { repository: createWorkspaceRepository({ indexedDB: new IDBFactory(), dbName: randomUUID(), runtime: runtime() }), runtime: runtime(), environment: { canCreate: false, canConnect: false, message: 'Use HTTPS or localhost with Web Crypto and WebRTC.' } });
  await vi.waitFor(() => expect(root().textContent).toContain('Use HTTPS or localhost'));
  app.destroy();
});