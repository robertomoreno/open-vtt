import { test, expect, chromium, webkit, type Browser, type BrowserType, type WebSocketRoute } from '@playwright/test';
import { createRoomLink, roomLink } from '../../src/network/room-link';
import { APP_URL, LOCAL_RELAY_URL } from './config';
import { ProviderGatePage } from './pages/provider-gate.page';

const engines: Record<string, BrowserType> = { chromium, webkit };
const localRelayPattern = new RegExp(`^${LOCAL_RELAY_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

async function open(browser: Browser, link: string, participant: string, sockets: WebSocketRoute[]): Promise<ProviderGatePage> {
  const context = await browser.newContext({ baseURL: APP_URL });
  const page = await context.newPage();
  // Intercept only the loopback signaling connection so the test can close it
  // to prove native channels survive signaling loss. It is not bridged: the
  // browser talks directly to the local relay.
  await page.routeWebSocket(localRelayPattern, ws => {
    sockets.push(ws);
    ws.connectToServer();
  });
  const gate = new ProviderGatePage(page);
  await gate.open(link, participant);
  return gate;
}

for (const [a, b] of [['chromium', 'webkit'], ['webkit', 'chromium']]) {
  test(`${a} ↔ ${b}: real Trystero Core signaling over the local relay opens native channels that carry exact large binary values in both directions, survive signaling loss, and tear down`, async () => {
    test.setTimeout(150_000);
    const browserA = await engines[a].launch(), browserB = await engines[b].launch();
    try {
      const link = roomLink(createRoomLink('gate-game'), `${APP_URL}/`);
      const socketsA: WebSocketRoute[] = [], socketsB: WebSocketRoute[] = [];
      const gateA = await open(browserA, link, 'alice', socketsA);
      const gateB = await open(browserB, link, 'bob', socketsB);

      await expect(gateA.phase).toHaveText(/looking|connected/, { timeout: 30_000 });
      await expect(gateA.opens).not.toHaveText('0', { timeout: 60_000 });
      await expect(gateB.opens).not.toHaveText('0', { timeout: 60_000 });
      await expect(gateA.phase).toHaveText('connected');
      await expect(gateB.phase).toHaveText('connected');
      expect(socketsA.length + socketsB.length).toBeGreaterThan(0);

      await gateA.publish('hello-from-a');
      await expect(gateB.received).toContainText('small-alice=hello-from-a');
      await gateA.publishLarge(7);
      await gateB.expectLargeValue('large-alice', 7);

      for (const ws of [...socketsA, ...socketsB]) await ws.close();

      await gateB.publish('after-closed-from-b');
      await expect(gateA.received).toContainText('small-bob=after-closed-from-b');
      await gateA.publish('after-closed-from-a');
      await expect(gateB.received).toContainText('small-alice=after-closed-from-a');
      await gateB.publishLarge(11);
      await gateA.expectLargeValue('large-bob', 11);
      await gateA.publishLarge(13);
      await gateB.expectLargeValue('large-alice', 13);
      await expect(gateA.opens).not.toHaveText('0');
      await expect(gateB.opens).not.toHaveText('0');

      await gateA.closeConnection();
      await expect(gateA.phase).toHaveText('closed');
      await expect(gateB.opens).toHaveText('0', { timeout: 30_000 });
      await expect(gateB.phase).toHaveText('looking');
      await gateB.closeConnection();
      await expect(gateB.phase).toHaveText('closed');
    } finally {
      await browserA.close(); await browserB.close();
    }
  });
}
