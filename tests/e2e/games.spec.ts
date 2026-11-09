import { test, expect } from './support/fixtures';
import { APP_URL } from './config';
import { GatherApp } from './pages/gather-app';
import { waitForSavedGame } from './support/storage';

test('create refresh restore and portable file roundtrip', async ({ app, browser }) => {
  await app.createGame('The Lantern Road', 'Alex');
  await app.table.roll();
  await expect(app.table.rolls).toHaveCount(1);
  await waitForSavedGame(app.page, { rolls: 1 });

  await app.page.reload();
  await app.start.continueGame('The Lantern Road');
  await expect(app.restore.hostAsSelect).toHaveValue(/.+/);
  await app.restore.open();
  await expect(app.table.rolls).toHaveCount(1);

  const file = await app.table.downloadGame();
  const path = (await file.path())!;

  const context = await browser.newContext({ baseURL: APP_URL });
  const fresh = new GatherApp(await context.newPage());
  await fresh.start.goto();
  await fresh.start.importFile(path);
  await fresh.restore.open();
  await expect(fresh.table.title).toHaveText('The Lantern Road');
  await expect(fresh.table.rolls).toHaveCount(1);
  await context.close();
});

test('invalid and canceled replacement imports preserve existing saves', async ({ app }) => {
  await app.createGame();
  await app.table.roll();
  await expect(app.table.rolls).toHaveCount(1);
  const path = await app.table.downloadGamePath();
  await waitForSavedGame(app.page, { rolls: 1 });
  await app.table.leave();

  await app.start.importFile(path);
  await expect(app.restore.replaceOpenButton).toBeVisible();
  await app.restore.cancel();

  await app.start.importFile({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"schemaVersion":2}'),
  });
  await expect(app.page.getByText('Unsupported backup format.')).toBeVisible();
  await expect(app.start.continueButtons).toHaveCount(1);
});

test('saved-game deletion is blocked while another tab holds the game open', async ({ app, context }) => {
  await app.createGame();
  await app.table.roll();
  await expect(app.table.rolls).toHaveCount(1);
  await waitForSavedGame(app.page, { rolls: 1 });
  await app.table.leave();
  await expect(app.start.continueButtons.first()).toBeVisible();

  const other = new GatherApp(await context.newPage());
  await other.start.goto();
  const deleteButton = other.start.deleteButton('The Lantern Road');
  await expect(deleteButton).toBeVisible();

  await app.start.continueGame('The Lantern Road');
  await app.restore.open();
  await expect(app.table.rollButton).toBeEnabled();

  const blockedDialog = other.page.waitForEvent('dialog');
  await deleteButton.click();
  const blocked = await blockedDialog;
  expect(blocked.message()).toContain('open in another tab');
  await blocked.dismiss();
  await expect(deleteButton).toBeVisible();

  await app.table.leave();
  await expect(app.start.createGameButton).toBeVisible();

  const confirmationDialog = other.page.waitForEvent('dialog');
  await deleteButton.click();
  const confirmation = await confirmationDialog;
  expect(confirmation.message()).toContain('Delete');
  await confirmation.accept();
  await expect(other.start.emptyState).toBeVisible();
  await other.page.reload();
  await expect(other.start.emptyState).toBeVisible();
  await other.page.close();
});

test('responsive keyboard forms preserve die selection and safe text', async ({ app }) => {
  await app.page.setViewportSize({ width: 390, height: 844 });
  await app.createGame('<img onerror=alert(1)>', 'Alex');
  await expect(app.page.locator('img')).toHaveCount(0);

  await app.table.chooseDie(6);
  await app.table.focusRoll();
  await app.page.keyboard.press('Enter');
  await expect(app.table.rolls).toHaveCount(1);
  await expect(app.table.dieSelect).toHaveValue('6');
  await expect(app.table.rollButton).toBeFocused();
  expect(await app.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await app.page.screenshot({ path: `test-results/table-${test.info().project.name}.png`, fullPage: true });
});
