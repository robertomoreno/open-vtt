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

export async function openSharedRoom(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.getByRole('button', { name: 'Open room' }).click();
  const output = page.locator('#room-link-output');
  await expect(output).toHaveValue(/\S/, { timeout: 40000 });
  return output.inputValue();
}

export async function joinSharedRoom(page: Page, link: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Room link').fill(link);
  await page.getByRole('button', { name: 'Join room' }).click();
  await page.waitForFunction(
    () => !!document.querySelector('#roll') || !!document.querySelector('#player-name') || !!document.querySelector('#choose-player'),
    undefined,
    { timeout: 60000 },
  );
}

export async function createConnectedPlayer(page: Page, name: string): Promise<void> {
  const choose = page.getByRole('button', { name: 'Choose player' });
  if (await choose.isVisible().catch(() => false)) await choose.click();
  await page.getByLabel('Player name').waitFor({ state: 'visible', timeout: 60000 });
  await page.getByLabel('Player name').fill(name);
  await page.getByRole('button', { name: 'Create player' }).click();
  const option = page.locator('#player-existing option', { hasText: name }).first();
  await expect(option).toBeAttached({ timeout: 60000 });
  const value = await option.getAttribute('value');
  await page.getByLabel('Available saved player').selectOption(value!);
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


