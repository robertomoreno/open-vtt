import { chromium, firefox, webkit, type BrowserType } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { Participant } from './support/participant';

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
    test.setTimeout(300_000);
    const hostBrowser = await engines[hostEngine].launch();
    const guestBrowser = await engines[guestEngine].launch();
    try {
      const host = await Participant.create(hostBrowser);
      const guest1 = await Participant.create(guestBrowser);
      const guest2 = await Participant.create(guestBrowser);

      await host.app.createGame('The Lantern Road');
      const link = await host.app.openSharedRoom();

      await guest1.app.joinSharedRoom(link);
      await host.app.table.addPlayer('Bea');
      await guest1.app.claimPlayer('Bea');

      await host.app.table.roll();
      await expect(host.app.table.rolls).toHaveCount(1);

      await guest1.app.table.chooseDie(6);
      await guest1.app.table.roll();
      await expect(host.app.table.rolls).toHaveCount(2);
      await expect(guest1.app.table.rolls).toHaveCount(2);

      await guest2.app.joinSharedRoom(link);
      await host.app.table.addPlayer('Cy');
      await guest2.app.claimPlayer('Cy');
      await expect(guest2.app.table.rolls).toHaveCount(2);

      await guest2.app.table.roll();
      await expect(host.app.table.rolls).toHaveCount(3);
      await expect(guest1.app.table.rolls).toHaveCount(3);
      await expect(guest2.app.table.rolls).toHaveCount(3);

      await guest2.app.table.choosePlayer();
      await expect(guest2.app.playerChooser.createForm).toBeHidden();
      await guest2.app.playerChooser.cancel();

      await guest1.app.table.leave();
      await guest1.app.joinSharedRoom(link);
      await expect(guest1.app.table.rollButton).toBeEnabled({ timeout: 60_000 });
      await expect(guest1.app.table.rolls).toHaveCount(3);

      await host.close();
      await guest1.app.table.choosePlayer();
      await expect(guest1.app.playerChooser.createForm).toBeHidden();
      await guest1.app.playerChooser.cancel();

      await expect(guest1.app.table.rolls).toHaveCount(3);
      await guest1.app.table.roll();
      await expect(guest1.app.table.rolls).toHaveCount(4);
      await expect(guest2.app.table.rolls).toHaveCount(4);

      const download = await guest1.app.table.downloadGame();
      expect(download.suggestedFilename()).toMatch(/\.json$/);
    } finally {
      await hostBrowser.close().catch(() => {});
      await guestBrowser.close().catch(() => {});
    }
  });
}
