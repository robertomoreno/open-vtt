import { test, expect } from './support/fixtures';

test('denied browser storage leaves local play and downloads usable', async ({ app }) => {
  await app.page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage denied'); } }));
  await app.createGame();
  await app.table.roll();
  await expect(app.page.getByText(/Browser save unavailable/)).toBeVisible();

  const download = await app.table.downloadGame();
  expect(download.suggestedFilename()).toMatch(/\.json$/);
});

test('missing WebRTC explains unsupported connection operations without crashing', async ({ app }) => {
  await app.page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', { value: undefined }));
  await app.start.goto();
  await expect(app.page.getByText(/WebRTC is unavailable/)).toBeVisible();

  await app.createGame();
  await app.table.openRoom();
  await expect(app.page.getByText(/WebRTC is unavailable/).first()).toBeVisible();
  await expect(app.share.linkOutput).toHaveCount(0);
  await expect(app.table.rollButton).toBeEnabled();
});
