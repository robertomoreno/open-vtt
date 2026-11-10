import { test, expect, chromium, webkit, type WebSocketRoute } from '@playwright/test';
import { createRoomLink, roomLink } from '../../src/network/room-link';
import { APP_URL } from './config';
import { ProviderGatePage } from './pages/provider-gate.page';

for (const [a, b] of [['chromium', 'webkit'], ['webkit', 'chromium']]) {
  test(`${a} ↔ ${b}: public Nostr discovery opens native channels and carries binary values`, async () => {
    test.setTimeout(180_000);
    const browserA = await (a === 'chromium' ? chromium : webkit).launch();
    const browserB = await (b === 'chromium' ? chromium : webkit).launch();
    try {
      const contextA = await browserA.newContext({ baseURL: APP_URL });
      const contextB = await browserB.newContext({ baseURL: APP_URL });
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();
      const socketsA: WebSocketRoute[] = [];
      const socketsB: WebSocketRoute[] = [];

      await pageA.routeWebSocket(/^wss:\/\//, ws => { socketsA.push(ws); ws.connectToServer(); });
      await pageB.routeWebSocket(/^wss:\/\//, ws => { socketsB.push(ws); ws.connectToServer(); });

      const link = roomLink(createRoomLink('nostr-gate-game'), `${APP_URL}/`);
      const gateA = new ProviderGatePage(pageA);
      const gateB = new ProviderGatePage(pageB);

      await gateA.open(link, 'alice');
      await gateB.open(link, 'bob');

      await expect(gateA.opens).not.toHaveText('0', { timeout: 90_000 });
      await expect(gateB.opens).not.toHaveText('0', { timeout: 90_000 });
      await expect(gateA.phase).toHaveText('connected');
      await expect(gateB.phase).toHaveText('connected');
      expect(socketsA.length + socketsB.length).toBeGreaterThan(0);

      await gateA.publish('nostr-hello-from-a');
      await expect(gateB.received).toContainText('small-alice=nostr-hello-from-a');
      await gateA.publishLarge(7);
      await gateB.expectLargeValue('large-alice', 7);

      for (const ws of [...socketsA, ...socketsB]) await ws.close();

      await gateB.publish('nostr-after-closed-from-b');
      await expect(gateA.received).toContainText('small-bob=nostr-after-closed-from-b');
      await gateA.publishLarge(11);
      await gateB.expectLargeValue('large-alice', 11);

      await gateA.closeConnection();
      await gateB.closeConnection();
      await contextA.close();
      await contextB.close();
    } finally {
      await browserA.close();
      await browserB.close();
    }
  });
}
