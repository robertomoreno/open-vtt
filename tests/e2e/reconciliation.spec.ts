import { test, expect, chromium } from '@playwright/test';
import { createGame, openSharedRoom, joinSharedRoom, countRolls, forkBackupFile } from './helpers';

test('offline forks merge with first-participant priority and recovery download', async () => {
  test.setTimeout(300000);
  const browser = await chromium.launch();
  try {
    const aliceContext = await browser.newContext({ baseURL: 'http://localhost:5173' });
    const bobContext = await browser.newContext({ baseURL: 'http://localhost:5173' });
    const carolContext = await browser.newContext({ baseURL: 'http://localhost:5173' });
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
