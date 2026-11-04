// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { mountApp } from '../../src/ui/app';
import { createWorkspaceRepository } from '../../src/storage/workspace-repository';
import { IDBFactory } from 'fake-indexeddb';
import { runtime } from '../helpers/game';
import { createWorkspace } from '../../src/game/workspace';
import { validateGame } from '../../src/game/validation';
import { randomUUID } from 'node:crypto';

beforeEach(() => { document.body.innerHTML = '<main id="root"></main>'; });
const root = () => document.querySelector<HTMLElement>('#root')!;

it('slow earlier import cannot replace a newly created live game', async () => {
  let resolve!: (game: any) => void;
  const pending = new Promise<any>((done) => { resolve = done; });
  const repo = createWorkspaceRepository({ indexedDB: new IDBFactory(), dbName: randomUUID(), runtime: runtime() });
  const app = mountApp(root(), { repository: repo, runtime: runtime(), parseFile: () => pending });
  await vi.waitFor(() => expect(root().querySelector('#import-file')).not.toBeNull());
  const input = root().querySelector<HTMLInputElement>('#import-file')!;
  Object.defineProperty(input, 'files', { value: [new File(['{}'], 'game.json')] });
  input.dispatchEvent(new Event('change'));
  (document.querySelector<HTMLInputElement>('#game-name')!).value = 'New live game';
  (document.querySelector<HTMLInputElement>('#creator-name')!).value = 'Alex';
  document.querySelector<HTMLFormElement>('#new-game')!.requestSubmit();
  resolve({ schemaVersion: 1, id: 'game', name: 'Imported', createdAt: '2026-10-27T12:00:00.000Z', updatedAt: '2026-10-27T12:00:00.000Z', revision: 0, players: [{ id: 'alex', name: 'Alex', role: 'gm' }], rolls: [] });
  await pending;
  await vi.waitFor(() => expect(root().textContent).toContain('New live game'));
  app.destroy();
});
it('replacement cancel leaves snapshot/history/version unchanged', async () => {
  const repo = createWorkspaceRepository({ indexedDB: new IDBFactory(), dbName: randomUUID(), runtime: runtime() });
  const imported = { schemaVersion: 1, id: 'id-1', name: 'Imported', createdAt: '2026-10-27T12:00:00.000Z', updatedAt: '2026-10-27T12:00:00.000Z', revision: 0, players: [{ id: 'alex', name: 'Alex', role: 'gm' }], rolls: [] };
  const game = validateGame(imported);
  const workspace = createWorkspace(game, runtime());
  const snapshot = workspace.getSnapshot();
  workspace.destroy();
  const app = mountApp(root(), { repository: repo, runtime: runtime(), parseFile: async () => snapshot });
  await vi.waitFor(() => expect(root().querySelector('#game-name')).not.toBeNull());
  (root().querySelector<HTMLInputElement>('#game-name')!).value = 'Original';
  (root().querySelector<HTMLInputElement>('#creator-name')!).value = 'Alex';
  root().querySelector<HTMLFormElement>('#new-game')!.requestSubmit();
  await vi.waitFor(() => expect(root().textContent).toContain('Original'));
  document.querySelector<HTMLButtonElement>('#roll')!.click();
  await vi.waitFor(async () => expect((await repo.list()).games.length).toBe(1));
  document.querySelector<HTMLButtonElement>('#leave')!.click();
  await vi.waitFor(() => expect(root().querySelector('#new-game')).not.toBeNull());
  const before = await repo.load('id-1');
  const input = root().querySelector<HTMLInputElement>('#import-file')!;
  Object.defineProperty(input, 'files', { value: [new File(['{}'], 'game.json')] });
  input.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(root().textContent).toContain('Replace saved game and open'));
  root().querySelector<HTMLButtonElement>('#cancel-restore')!.click();
  await vi.waitFor(() => expect(root().querySelector('#new-game')).not.toBeNull());
  const after = await repo.load('id-1');
  expect(after.version).toBe(before.version);
  expect(after.snapshot?.game.name).toBe('Original');
  app.destroy();
});

it('old save resolves after leave/remount', async () => {
  const repo = createWorkspaceRepository({ indexedDB: new IDBFactory(), dbName: randomUUID(), runtime: runtime() });
  const app = mountApp(root(), { repository: repo, runtime: runtime() });
  await vi.waitFor(() => expect(root().querySelector('#game-name')).not.toBeNull());
  (root().querySelector<HTMLInputElement>('#game-name')!).value = 'First';
  (root().querySelector<HTMLInputElement>('#creator-name')!).value = 'Alex';
  root().querySelector<HTMLFormElement>('#new-game')!.requestSubmit();
  await vi.waitFor(() => expect(root().textContent).toContain('First'));
  document.querySelector<HTMLButtonElement>('#roll')!.click();
  await vi.waitFor(async () => expect((await repo.list()).games.length).toBe(1));
  document.querySelector<HTMLButtonElement>('#leave')!.click();
  await vi.waitFor(() => expect(root().querySelector('#new-game')).not.toBeNull());
  (root().querySelector<HTMLInputElement>('#game-name')!).value = 'Second';
  (root().querySelector<HTMLInputElement>('#creator-name')!).value = 'Alex';
  root().querySelector<HTMLFormElement>('#new-game')!.requestSubmit();
  await vi.waitFor(() => expect(root().textContent).toContain('Second'));
  expect(root().textContent).not.toContain('First');
  app.destroy();
});
