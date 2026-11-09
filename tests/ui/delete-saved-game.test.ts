// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { randomUUID } from 'node:crypto';
import { mountApp } from '../../src/ui/app';
import { createWorkspaceRepository } from '../../src/storage/workspace-repository';
import type { TabLocks } from '../../src/ui/tab-locks';
import { runtime } from '../helpers/game';
import { createTestWorkspace } from '../helpers/workspace';

beforeEach(() => { document.body.innerHTML = '<main id="root"></main>'; });
const root = () => document.querySelector<HTMLElement>('#root')!;

function fakeTabLocks(busyIds: string[] = []): TabLocks {
  return { hold: () => () => {}, isBusy: async id => busyIds.includes(id) };
}

async function mountSavedGame(busyIds: string[] = []) {
  const repo = createWorkspaceRepository({ indexedDB: new IDBFactory(), dbName: randomUUID(), runtime: runtime() });
  const snapshot = createTestWorkspace('seed').getSnapshot();
  expect(await repo.save(snapshot, 0)).toEqual({ ok: true, version: 1 });
  const confirm = vi.fn(() => true);
  const alert = vi.fn();
  const app = mountApp(root(), { repository: repo, runtime: runtime(), confirm, alert, tabLocks: fakeTabLocks(busyIds) });
  const button = await vi.waitFor(() => {
    const found = root().querySelector<HTMLButtonElement>('[data-delete="game"]');
    expect(found).not.toBeNull();
    return found!;
  });
  return { repo, confirm, alert, app, button };
}

it('deletes the saved game after confirmation', async () => {
  const { repo, confirm, alert, app, button } = await mountSavedGame();
  button.click();
  await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Castle')));
  await vi.waitFor(async () => expect((await repo.list()).games).toEqual([]));
  expect(root().textContent).toContain('No games saved here yet');
  expect(alert).not.toHaveBeenCalled();
  app.destroy();
});

it('alerts and keeps the game when another tab has it open', async () => {
  const { repo, confirm, alert, app, button } = await mountSavedGame(['game']);
  button.click();
  await vi.waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringContaining('open in another tab')));
  expect(confirm).not.toHaveBeenCalled();
  expect((await repo.list()).games.map(game => game.id)).toEqual(['game']);
  expect(root().querySelector('[data-delete="game"]')).not.toBeNull();
  app.destroy();
});

it('keeps the game when deletion is canceled', async () => {
  const { repo, confirm, alert, app, button } = await mountSavedGame();
  confirm.mockReturnValue(false);
  button.click();
  await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
  expect(alert).not.toHaveBeenCalled();
  expect((await repo.list()).games.map(game => game.id)).toEqual(['game']);
  expect(root().querySelector('[data-delete="game"]')).not.toBeNull();
  app.destroy();
});
