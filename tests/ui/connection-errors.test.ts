// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { mountApp } from '../../src/ui/app';
import { createWorkspaceRepository } from '../../src/storage/workspace-repository';
import { IDBFactory } from 'fake-indexeddb';
import { runtime } from '../helpers/game';
import { randomUUID } from 'node:crypto';

beforeEach(() => { document.body.innerHTML = '<main id="root"></main>'; });
const root = () => document.querySelector<HTMLElement>('#root')!;

it('renders start screen without crashing', async () => {
  const app = mountApp(root(), { repository: createWorkspaceRepository({ indexedDB: new IDBFactory(), dbName: randomUUID(), runtime: runtime() }), runtime: runtime() });
  await vi.waitFor(() => expect(root().textContent).toContain('Gather'));
  app.destroy();
});