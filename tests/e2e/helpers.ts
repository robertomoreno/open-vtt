import { expect, type Page } from '@playwright/test';
import type { LocalEdit } from '../../src/game/sync-types';
import { createWorkspace } from '../../src/game/workspace';
import { parseBackup, serializeBackup } from '../../src/storage/backups';
import { namedRuntime } from '../helpers/workspace';
import { readFile } from 'node:fs/promises';

export async function createGame(page: Page, name = 'The Lantern Road') {
  await page.goto('/');
  await page.getByLabel('Game name', { exact: true }).fill(name);
  await page.getByLabel('Your name', { exact: true }).fill('Alex');
  await page.getByRole('button', { name: 'Create game' }).click();
  await expect(page.locator('#roll')).toBeEnabled();
}

export async function waitForSavedGame(page: Page): Promise<void> {
  await page.waitForFunction(() => new Promise<boolean>(resolve => {
    const request = indexedDB.open('gather-workspaces');
    request.onerror = () => resolve(false);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('games')) { db.close(); resolve(false); return; }
      const all = db.transaction('games', 'readonly').objectStore('games').getAll();
      all.onsuccess = () => { const saved = all.result.length > 0; db.close(); resolve(saved); };
      all.onerror = () => { db.close(); resolve(false); };
    };
  }));
}

export async function openSharedRoom(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Connect' }).click();
  const output = page.locator('#room-link-output');
  await expect(output).toHaveValue(/\S/, { timeout: 40000 });
  return output.inputValue();
}

export async function joinSharedRoom(page: Page, link: string): Promise<void> {
  await page.goto(link);
  await page.waitForFunction(
    () => !!document.querySelector('#roll') || !!document.querySelector('#player-existing') || !!document.querySelector('#join-selected-player'),
    undefined,
    { timeout: 60000 },
  );
}

export async function addPlayerAsGm(page: Page, name: string): Promise<void> {
  const input = page.getByLabel('New player name');
  await input.waitFor({ state: 'visible', timeout: 60000 });
  await expect(input).toBeEnabled({ timeout: 60000 });
  await input.fill(name);
  const add = page.getByRole('button', { name: 'Add player' });
  await expect(add).toBeEnabled({ timeout: 60000 });
  await add.click();
  await expect(input).toHaveValue('', { timeout: 60000 });
}

export async function claimPlayer(page: Page, name: string): Promise<void> {
  const option = page.locator('#player-existing option', { hasText: name }).first();
  await expect(option).toBeAttached({ timeout: 60000 });
  const value = await option.getAttribute('value');
  await page.getByLabel('Available saved player').selectOption(value!);
  await page.locator('#join-selected-player').click();
  await expect(page.locator('#roll')).toBeEnabled({ timeout: 60000 });
}

export async function countRolls(page: Page, count: number) {
  await expect(page.locator('[data-roll]')).toHaveCount(count);
}

export async function forkBackupFile(path: string, edit: LocalEdit, label: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const text = await readFile(path, 'utf8');
  const runtime = namedRuntime(label);
  const snapshot = parseBackup(text, runtime);
  const workspace = createWorkspace(snapshot, runtime);
  workspace.applyLocal(edit);
  const forked = workspace.getSnapshot();
  workspace.destroy();
  const serialized = serializeBackup(forked);
  return {
    name: `gather-${label}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(serialized, 'utf8'),
  };
}


