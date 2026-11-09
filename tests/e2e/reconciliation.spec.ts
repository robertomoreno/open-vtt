import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { Participant } from './support/participant';
import { forkBackupFile } from './support/backups';
import { waitForSavedGame } from './support/storage';

test('offline forks merge with first-participant priority and recovery download', async () => {
  test.setTimeout(300_000);
  const browser = await chromium.launch();
  try {
    const alice = await Participant.create(browser);
    const bob = await Participant.create(browser);
    const carol = await Participant.create(browser);

    await alice.app.createGame('Old Castle');
    const link = await alice.app.openSharedRoom();
    const basePath = await alice.app.table.downloadGamePath();

    const bobFile = await forkBackupFile(basePath, { type: 'set-game-name', name: 'Red Castle' }, 'bob');
    const carolFile = await forkBackupFile(basePath, { type: 'set-game-name', name: 'Blue Castle' }, 'carol');

    // Bob imports his offline fork, then joins the shared room.
    await bob.app.start.goto();
    await bob.app.start.importFile(bobFile);
    await bob.app.restore.open();
    await expect(bob.app.table.title).toHaveText('Red Castle');
    await bob.app.table.roll();
    await waitForSavedGame(bob.page);
    await bob.app.table.leave();
    await bob.app.joinSharedRoom(link);
    await alice.app.table.addPlayer('Bea');
    await bob.app.claimPlayer('Bea');

    // Bob's offline rename is accepted while Alice's copy is unchanged.
    await expect(alice.app.table.title).toHaveText('Red Castle', { timeout: 60_000 });

    // Carol imports her offline fork, then joins.
    await carol.app.start.goto();
    await carol.app.start.importFile(carolFile);
    await carol.app.restore.open();
    await carol.app.table.roll();
    await waitForSavedGame(carol.page);
    await carol.app.table.leave();
    await carol.app.joinSharedRoom(link);
    await alice.app.table.addPlayer('Cy');
    await carol.app.claimPlayer('Cy');

    // The first participant's current version survives Carol's competing fork, with a warning.
    await expect(alice.app.table.title).toHaveText('Red Castle');
    await expect(alice.app.table.status).toContainText(/first room participant/i, { timeout: 60_000 });

    // Pre-merge recovery download remains available.
    await expect(alice.app.table.downloadRecoveryButton).toBeVisible();
    const recovery = await alice.app.table.downloadRecovery();
    expect(recovery.suggestedFilename()).toMatch(/\.json$/);
  } finally {
    await browser.close().catch(() => {});
  }
});

test('independent player-field edits survive reconciliation', async () => {
  test.setTimeout(300_000);
  const browser = await chromium.launch();
  try {
    const alice = await Participant.create(browser);
    const bob = await Participant.create(browser);
    const carol = await Participant.create(browser);

    await alice.app.createGame('Old Castle');
    const link = await alice.app.openSharedRoom();
    const basePath = await alice.app.table.downloadGamePath();

    const baseGame = JSON.parse(await readFile(basePath, 'utf8')).game;
    const alexId = baseGame.players[0].id;

    // Bob edits the game name; Carol edits an independent player field.
    const bobFile = await forkBackupFile(basePath, { type: 'set-game-name', name: 'Red Castle' }, 'bob');
    const carolFile = await forkBackupFile(basePath, { type: 'set-player-name', playerId: alexId, name: 'Alexandra' }, 'carol');

    await bob.app.start.goto();
    await bob.app.start.importFile(bobFile);
    await bob.app.restore.open();
    await expect(bob.app.table.title).toHaveText('Red Castle');
    await bob.app.table.roll();
    await waitForSavedGame(bob.page);
    await bob.app.table.leave();
    await bob.app.joinSharedRoom(link);
    await alice.app.table.addPlayer('Bea');
    await bob.app.claimPlayer('Bea');

    await carol.app.start.goto();
    await carol.app.start.importFile(carolFile);
    await carol.app.restore.open();
    await carol.app.table.roll();
    await waitForSavedGame(carol.page);
    await carol.app.table.leave();
    await carol.app.joinSharedRoom(link);
    await alice.app.table.addPlayer('Cy');
    await carol.app.claimPlayer('Cy');

    // Both independent edits survive the merge.
    await expect(alice.app.table.title).toHaveText('Red Castle', { timeout: 60_000 });
    await expect(alice.app.table.rosterEntry('Alexandra')).toBeVisible({ timeout: 60_000 });
    await expect(bob.app.table.title).toHaveText('Red Castle', { timeout: 60_000 });
    await expect(bob.app.table.rosterEntry('Alexandra')).toBeVisible({ timeout: 60_000 });
  } finally {
    await browser.close().catch(() => {});
  }
});

test('successor Dave starts from current Red', async () => {
  test.setTimeout(300_000);
  const browser = await chromium.launch();
  try {
    const alice = await Participant.create(browser);
    const dave = await Participant.create(browser);
    const carol = await Participant.create(browser);

    await alice.app.createGame('Old Castle');
    const link = await alice.app.openSharedRoom();
    const basePath = await alice.app.table.downloadGamePath();

    const daveFile = await forkBackupFile(basePath, { type: 'set-game-name', name: 'Red Castle' }, 'dave');
    const carolFile = await forkBackupFile(basePath, { type: 'set-game-name', name: 'Blue Castle' }, 'carol');

    // Dave imports the Red fork and joins while Alice is still the first participant,
    // so Red becomes the currently accepted value.
    await dave.app.start.goto();
    await dave.app.start.importFile(daveFile);
    await dave.app.restore.open();
    await dave.app.table.roll();
    await waitForSavedGame(dave.page);
    await dave.app.table.leave();
    await dave.app.joinSharedRoom(link);
    await alice.app.table.addPlayer('Dave');
    await dave.app.claimPlayer('Dave');

    await expect(alice.app.table.title).toHaveText('Red Castle', { timeout: 60_000 });
    await expect(dave.app.table.title).toHaveText('Red Castle', { timeout: 60_000 });

    // Alice (first participant) leaves; Dave becomes the successor.
    await alice.close();

    // Carol imports the Blue fork and joins after succession. The successor's Red wins.
    await carol.app.start.goto();
    await carol.app.start.importFile(carolFile);
    await carol.app.restore.open();
    await carol.app.table.roll();
    await waitForSavedGame(carol.page);
    await carol.app.table.leave();
    await carol.app.joinSharedRoom(link);
    await expect(carol.app.table.rollButton).toBeEnabled({ timeout: 60_000 });

    await expect(dave.app.table.title).toHaveText('Red Castle', { timeout: 60_000 });
    await expect(carol.app.table.title).toHaveText('Red Castle', { timeout: 60_000 });
    await expect(dave.app.table.status).toContainText(/first room participant/i, { timeout: 60_000 });
  } finally {
    await browser.close().catch(() => {});
  }
});
