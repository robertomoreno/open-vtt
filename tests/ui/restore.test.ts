// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { mountApp } from '../../src/ui/app';
import { createWorkspaceRepository } from '../../src/storage/workspace-repository';
import { IDBFactory } from 'fake-indexeddb';
import { runtime } from '../helpers/game';
import { randomUUID } from 'node:crypto';

beforeEach(() => { document.body.innerHTML = '<main id="root"></main>'; });
const root = () => document.querySelector<HTMLElement>('#root')!;

it('does not replace a newly created live view with an earlier slow import', async () => {
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