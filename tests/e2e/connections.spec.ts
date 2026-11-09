import { test, expect, chromium, firefox, webkit, type BrowserType } from '@playwright/test';
import { createGame, openSharedRoom, joinSharedRoom, addPlayerAsGm, claimPlayer, countRolls } from './helpers';
import { APP_URL } from './config';

const engines: Record<string, BrowserType> = { chromium, firefox, webkit };

const directions: Array<[string, string]> = [
  ['chromium', 'chromium'],
  ['firefox', 'firefox'],
  ['webkit', 'webkit'],
  ['chromium', 'firefox'],
  ['firefox', 'chromium'],
  ['chromium', 'webkit'],
  ['webkit', 'chromium'],
  ['firefox', 'webkit'],
  ['webkit', 'firefox'],
];

for (const [hostEngine, guestEngine] of directions) {
  test(`${hostEngine} host ↔ ${guestEngine} guests: shared room, claims, rolls, departure, rejoin, download`, async () => {
    test.setTimeout(300000);
    const hostBrowser = await engines[hostEngine].launch();
    const guestBrowser = await engines[guestEngine].launch();
    try {
      const hostContext = await hostBrowser.newContext({ baseURL: APP_URL });
      const guestContext1 = await guestBrowser.newContext({ baseURL: APP_URL });
      const guestContext2 = await guestBrowser.newContext({ baseURL: APP_URL });
      const host = await hostContext.newPage();
      const guest1 = await guestContext1.newPage();
      const guest2 = await guestContext2.newPage();

      await createGame(host, 'The Lantern Road');
      const link = await openSharedRoom(host);

      await joinSharedRoom(guest1, link);
      await addPlayerAsGm(host, 'Bea');
      await claimPlayer(guest1, 'Bea');

      await host.locator('#roll').click();
      await countRolls(host, 1);

      await guest1.getByRole('combobox', { name: 'Die', exact: true }).selectOption('6');
      await guest1.locator('#roll').click();
      await countRolls(host, 2);
      await countRolls(guest1, 2);

      await joinSharedRoom(guest2, link);
      await addPlayerAsGm(host, 'Cy');
      await claimPlayer(guest2, 'Cy');
      await countRolls(guest2, 2);

      await guest2.locator('#roll').click();
      await countRolls(host, 3);
      await countRolls(guest1, 3);
      await countRolls(guest2, 3);

      await guest2.getByRole('button', { name: 'Choose player' }).click();
      await expect(guest2.locator('#create-player-form')).toBeHidden();
      await guest2.getByRole('button', { name: 'Cancel' }).click();

      await guest1.locator('#leave').click();
      await joinSharedRoom(guest1, link);
      await expect(guest1.locator('#roll')).toBeEnabled({ timeout: 60000 });
      await countRolls(guest1, 3);

      await host.close();
      await guest1.getByRole('button', { name: 'Choose player' }).click();
      await expect(guest1.locator('#create-player-form')).toBeHidden();
      await guest1.getByRole('button', { name: 'Cancel' }).click();

      await countRolls(guest1, 3);

      await guest1.locator('#roll').click();
      await countRolls(guest1, 4);
      await countRolls(guest2, 4);

      const downloadPromise = guest1.waitForEvent('download');
      await guest1.locator('#download').click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/\.json$/);
    } finally {
      await hostBrowser.close().catch(() => {});
      await guestBrowser.close().catch(() => {});
    }
  });
}
