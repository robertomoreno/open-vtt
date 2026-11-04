// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { mountApp } from '../../src/ui/app';
import { createWorkspaceRepository } from '../../src/storage/workspace-repository';
import { runtime } from '../helpers/game';
import { randomUUID } from 'node:crypto';

beforeEach(() => { document.body.innerHTML = '<main id="root"></main>'; localStorage.clear(); });

const root = () => document.querySelector<HTMLElement>('#root')!;

it('queues accepted generations in order', async () => {
  const repo = createWorkspaceRepository({ indexedDB: globalThis.indexedDB, dbName: randomUUID(), runtime: runtime() });
  const app = mountApp(root(), { repository: repo, runtime: runtime() });
  await vi.waitFor(() => expect(root().querySelector('#game-name')).not.toBeNull());
  (root().querySelector<HTMLInputElement>('#game-name')!).value = 'Auto';
  (root().querySelector<HTMLInputElement>('#creator-name')!).value = 'Alex';
  root().querySelector<HTMLFormElement>('#new-game')!.requestSubmit();
  await vi.waitFor(() => expect(root().textContent).toContain('Auto'));
  document.querySelector<HTMLButtonElement>('#roll')!.click();
  await vi.waitFor(async () => expect((await repo.list()).games.length).toBe(1));
  app.destroy();
});

it('never skips accepted generations when two peers share a legacy revision', async () => {
  const repo = createWorkspaceRepository({ indexedDB: globalThis.indexedDB, dbName: randomUUID(), runtime: runtime() });
  const app = mountApp(root(), { repository: repo, runtime: runtime() });
  await vi.waitFor(() => expect(root().querySelector('#game-name')).not.toBeNull());
  (root().querySelector<HTMLInputElement>('#game-name')!).value = 'Auto';
  (root().querySelector<HTMLInputElement>('#creator-name')!).value = 'Alex';
  root().querySelector<HTMLFormElement>('#new-game')!.requestSubmit();
  await vi.waitFor(() => expect(root().textContent).toContain('Auto'));
  document.querySelector<HTMLButtonElement>('#roll')!.click();
  await vi.waitFor(() => expect(root().textContent).toContain('Auto'));
  document.querySelector<HTMLButtonElement>('#roll')!.click();
  await vi.waitFor(async () => {
    const loaded = await repo.load('id-1');
    expect(loaded.version).toBeGreaterThanOrEqual(2);
  });
  app.destroy();
});

it('stale-CAS warnings preserve the in-memory backup', async () => {
  const repo = createWorkspaceRepository({ indexedDB: globalThis.indexedDB, dbName: randomUUID(), runtime: runtime() });
  const originalSave = repo.save.bind(repo);
  let staleOnce = true;
  repo.save = async (snapshot, expectedVersion) => {
    if (staleOnce) {
      staleOnce = false;
      return { ok: false, reason: 'stale', message: 'Another tab saved a newer version first.' };
    }
    return originalSave(snapshot, expectedVersion);
  };
  const app = mountApp(root(), { repository: repo, runtime: runtime() });
  await vi.waitFor(() => expect(root().querySelector('#game-name')).not.toBeNull());
  (root().querySelector<HTMLInputElement>('#game-name')!).value = 'Auto';
  (root().querySelector<HTMLInputElement>('#creator-name')!).value = 'Alex';
  root().querySelector<HTMLFormElement>('#new-game')!.requestSubmit();
  await vi.waitFor(() => expect(root().textContent).toContain('Auto'));
  document.querySelector<HTMLButtonElement>('#roll')!.click();
  await vi.waitFor(() => expect(root().textContent).toContain('newer version first'));
  expect(document.querySelector('#download-recovery')).not.toBeNull();
  app.destroy();
});
