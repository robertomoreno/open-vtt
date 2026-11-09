import { test, expect } from './support/fixtures';
import { Participant } from './support/participant';

const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test('players exchange public, private and image chat', async ({ browser }) => {
  test.setTimeout(240_000);
  const host = await Participant.create(browser);
  const bea = await Participant.create(browser);
  const cy = await Participant.create(browser);
  try {
    await host.app.createGame('The Chat Table');
    const link = await host.app.openSharedRoom();
    await bea.app.joinSharedRoom(link);
    await host.app.table.addPlayer('Bea');
    await bea.app.claimPlayer('Bea');
    await cy.app.joinSharedRoom(link);
    await host.app.table.addPlayer('Cy');
    await cy.app.claimPlayer('Cy');

    await host.app.table.sendChat('Hello, table');
    await expect(host.app.table.chatEntries).toHaveCount(1);
    await expect(bea.app.table.chatEntries).toHaveCount(1);
    await expect(cy.app.table.chatEntries).toHaveCount(1);

    await host.app.table.sendPrivateChat('Only Bea may read this', ['Bea']);
    await expect(host.app.table.chatEntries).toHaveCount(2);
    await expect(bea.app.table.chatEntries).toHaveCount(2);
    await expect(cy.app.table.chatEntries).toHaveCount(1);
    await expect(cy.app.table.chatEntries).not.toContainText('Only Bea may read this');

    await host.app.table.attachImage({ name: 'pixel.png', mimeType: 'image/png', buffer: PIXEL_PNG });
    await host.app.table.sendAttachedImage();
    await expect(host.app.table.chatEntries).toHaveCount(3);
    await expect(bea.app.table.chatEntries).toHaveCount(3);
    await expect(cy.app.table.chatEntries).toHaveCount(2);
    await expect(host.app.table.chatImages).toHaveCount(1);
    await expect(bea.app.table.chatImages).toHaveCount(1);
    await expect(cy.app.table.chatImages).toHaveCount(1);
  } finally {
    await host.close();
    await bea.close();
    await cy.close();
  }
});
