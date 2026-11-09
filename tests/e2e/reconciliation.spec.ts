import { readFile } from 'node:fs/promises';
import { test, expect, chromium } from '@playwright/test';
import { createGame, openSharedRoom, joinSharedRoom, countRolls, forkBackupFile } from './helpers';
import { APP_URL } from './config';

test('offline forks merge with first-participant priority and recovery download', async () => {
  test.setTimeout(300000);
  const browser = await chromium.launch();
  try {
    const aliceContext = await browser.newContext({ baseURL: APP_URL });
    const bobContext = await browser.newContext({ baseURL: APP_URL });
    const carolContext = await browser.newContext({ baseURL: APP_URL });
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    const carol = await carolContext.newPage();

    await createGame(alice, 'Old Castle');
    const link = await openSharedRoom(alice);

    const downloadPromise = alice.waitForEvent('download');
    await alice.locator('#download').click();
    const basePath = (await (await downloadPromise).path())!;

    const bobFile = await forkBackupFile(basePath, { type: 'set-game-name', name: 'Red Castle' }, 'bob');
    const carolFile = await forkBackupFile(basePath, { type: 'set-game-name', name: 'Blue Castle' }, 'carol');

    // Bob imports his offline fork, then joins the shared room.
    await bob.goto('/');
    await bob.getByLabel('Load state file').setInputFiles(bobFile);
    await bob.getByRole('button', { name: 'Open game', exact: true }).click();
    await bob.locator('#leave').click();
    await joinSharedRoom(bob, link);
    const bobChoose = bob.getByRole('button', { name: 'Choose player' });
    if (await bobChoose.isVisible().catch(() => false)) await bobChoose.click();
    await bob.getByLabel('Available saved player').waitFor({ state: 'visible', timeout: 60000 });
    const bobOption = bob.locator('#player-existing option', { hasText: 'Alex' }).first();
    const bobValue = await bobOption.getAttribute('value');
    await bob.getByLabel('Available saved player').selectOption(bobValue!);
    await expect(bob.locator('#roll')).toBeEnabled({ timeout: 60000 });

    // Carol imports her offline fork, then joins.
    await carol.goto('/');
    await carol.getByLabel('Load state file').setInputFiles(carolFile);
    await carol.getByRole('button', { name: 'Open game', exact: true }).click();
    await carol.locator('#leave').click();
    await joinSharedRoom(carol, link);
    const carolChoose = carol.getByRole('button', { name: 'Choose player' });
    if (await carolChoose.isVisible().catch(() => false)) await carolChoose.click();
    await carol.getByLabel('Available saved player').waitFor({ state: 'visible', timeout: 60000 });
    const carolOption = carol.locator('#player-existing option', { hasText: 'Alex' }).first();
    const carolValue = await carolOption.getAttribute('value');
    await carol.getByLabel('Available saved player').selectOption(carolValue!);

    // Alice retains the first-participant value with a detailed warning.
    await expect(alice.getByText(/first room participant/i)).toBeVisible({ timeout: 60000 });
    await expect(alice.getByRole('heading', { name: 'Old Castle' })).toBeVisible();

    // Pre-merge recovery download remains available.
    await expect(alice.locator('#download-recovery')).toBeVisible();
    const recoveryPromise = alice.waitForEvent('download');
    await alice.locator('#download-recovery').click();
    const recoveryDownload = await recoveryPromise;
    expect(recoveryDownload.suggestedFilename()).toMatch(/\.json$/);
  } finally {
    await browser.close().catch(() => {});
  }
});

test('independent player-field edits survive reconciliation', async () => {
  test.setTimeout(300000);
  const browser = await chromium.launch();
  try {
    const aliceContext = await browser.newContext({ baseURL: APP_URL });
    const bobContext = await browser.newContext({ baseURL: APP_URL });
    const carolContext = await browser.newContext({ baseURL: APP_URL });
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    const carol = await carolContext.newPage();

    await createGame(alice, 'Old Castle');
    const link = await openSharedRoom(alice);

    const downloadPromise = alice.waitForEvent('download');
    await alice.locator('#download').click();
    const basePath = (await (await downloadPromise).path())!;

    const baseGame = JSON.parse(await readFile(basePath, 'utf8')).game;
    const alexId = baseGame.players[0].id;

    // Bob edits the game name; Carol edits an independent player field.
    const bobFile = await forkBackupFile(basePath, { type: 'set-game-name', name: 'Red Castle' }, 'bob');
    const carolFile = await forkBackupFile(basePath, { type: 'set-player-name', playerId: alexId, name: 'Alexandra' }, 'carol');

    await bob.goto('/');
    await bob.getByLabel('Load state file').setInputFiles(bobFile);
    await bob.getByRole('button', { name: 'Open game', exact: true }).click();
    await bob.locator('#leave').click();
    await joinSharedRoom(bob, link);
    const bobChoose = bob.getByRole('button', { name: 'Choose player' });
    if (await bobChoose.isVisible().catch(() => false)) await bobChoose.click();
    await bob.getByLabel('Available saved player').waitFor({ state: 'visible', timeout: 60000 });
    const bobOption = bob.locator('#player-existing option', { hasText: 'Alex' }).first();
    const bobValue = await bobOption.getAttribute('value');
    await bob.getByLabel('Available saved player').selectOption(bobValue!);
    await expect(bob.locator('#roll')).toBeEnabled({ timeout: 60000 });

    await carol.goto('/');
    await carol.getByLabel('Load state file').setInputFiles(carolFile);
    await carol.getByRole('button', { name: 'Open game', exact: true }).click();
    await carol.locator('#leave').click();
    await joinSharedRoom(carol, link);
    const carolChoose = carol.getByRole('button', { name: 'Choose player' });
    if (await carolChoose.isVisible().catch(() => false)) await carolChoose.click();
    await carol.getByLabel('Available saved player').waitFor({ state: 'visible', timeout: 60000 });
    const carolOption = carol.locator('#player-existing option', { hasText: 'Alex' }).first();
    const carolValue = await carolOption.getAttribute('value');
    await carol.getByLabel('Available saved player').selectOption(carolValue!);

    // Both independent edits survive the merge.
    await expect(alice.getByRole('heading', { name: 'Red Castle' })).toBeVisible({ timeout: 60000 });
    await expect(alice.getByText('Alexandra')).toBeVisible({ timeout: 60000 });
    await expect(bob.getByRole('heading', { name: 'Red Castle' })).toBeVisible({ timeout: 60000 });
    await expect(bob.getByText('Alexandra')).toBeVisible({ timeout: 60000 });
  } finally {
    await browser.close().catch(() => {});
  }
});

test('successor Dave starts from current Red', async () => {
  test.setTimeout(300000);
  const browser = await chromium.launch();
  try {
    const aliceContext = await browser.newContext({ baseURL: APP_URL });
    const daveContext = await browser.newContext({ baseURL: APP_URL });
    const carolContext = await browser.newContext({ baseURL: APP_URL });
    const alice = await aliceContext.newPage();
    const dave = await daveContext.newPage();
    const carol = await carolContext.newPage();

    await createGame(alice, 'Old Castle');
    const link = await openSharedRoom(alice);

    const downloadPromise = alice.waitForEvent('download');
    await alice.locator('#download').click();
    const basePath = (await (await downloadPromise).path())!;

    const daveFile = await forkBackupFile(basePath, { type: 'set-game-name', name: 'Red Castle' }, 'dave');
    const carolFile = await forkBackupFile(basePath, { type: 'set-game-name', name: 'Blue Castle' }, 'carol');

    // Dave imports the Red fork and joins while Alice is still the first participant,
    // so Red becomes the currently accepted value.
    await dave.goto('/');
    await dave.getByLabel('Load state file').setInputFiles(daveFile);
    await dave.getByRole('button', { name: 'Open game', exact: true }).click();
    await dave.locator('#leave').click();
    await joinSharedRoom(dave, link);
    const daveChoose = dave.getByRole('button', { name: 'Choose player' });
    if (await daveChoose.isVisible().catch(() => false)) await daveChoose.click();
    await dave.getByLabel('Available saved player').waitFor({ state: 'visible', timeout: 60000 });
    const daveOption = dave.locator('#player-existing option', { hasText: 'Alex' }).first();
    const daveValue = await daveOption.getAttribute('value');
    await dave.getByLabel('Available saved player').selectOption(daveValue!);
    await expect(dave.locator('#roll')).toBeEnabled({ timeout: 60000 });

    await expect(alice.getByRole('heading', { name: 'Red Castle' })).toBeVisible({ timeout: 60000 });
    await expect(dave.getByRole('heading', { name: 'Red Castle' })).toBeVisible({ timeout: 60000 });

    // Alice (first participant) leaves; Dave becomes the successor.
    await alice.close();

    // Carol imports the Blue fork and joins after succession. The successor's Red wins.
    await carol.goto('/');
    await carol.getByLabel('Load state file').setInputFiles(carolFile);
    await carol.getByRole('button', { name: 'Open game', exact: true }).click();
    await carol.locator('#leave').click();
    await joinSharedRoom(carol, link);
    const carolChoose = carol.getByRole('button', { name: 'Choose player' });
    if (await carolChoose.isVisible().catch(() => false)) await carolChoose.click();
    await carol.getByLabel('Available saved player').waitFor({ state: 'visible', timeout: 60000 });
    const carolOption = carol.locator('#player-existing option', { hasText: 'Alex' }).first();
    const carolValue = await carolOption.getAttribute('value');
    await carol.getByLabel('Available saved player').selectOption(carolValue!);

    await expect(dave.getByRole('heading', { name: 'Red Castle' })).toBeVisible({ timeout: 60000 });
    await expect(carol.getByRole('heading', { name: 'Red Castle' })).toBeVisible({ timeout: 60000 });
    await expect(dave.getByText(/first room participant/i)).toBeVisible({ timeout: 60000 });
  } finally {
    await browser.close().catch(() => {});
  }
});