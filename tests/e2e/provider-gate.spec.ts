import { test, expect, chromium, webkit, type Browser, type BrowserType, type Page, type WebSocketRoute } from '@playwright/test';
import { createRoomLink, roomLink } from '../../src/network/room-link';

const engines: Record<string, BrowserType> = { chromium, webkit };
const FIXTURE = '/tests/e2e/fixtures/provider-gate.html';

function expectedLarge(seed: number): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < 1_500_000; i++) { h ^= (i * 31 + seed * 17 + (i >> 8)) & 255; h = Math.imul(h, 0x01000193) >>> 0; }
  return `1500000:${h}`;
}

async function open(browser: Browser, link: string, participant: string, sockets: WebSocketRoute[]): Promise<Page> {
  const context = await browser.newContext({ baseURL: 'http://localhost:5173' });
  const page = await context.newPage();
  await page.routeWebSocket(/^wss:/, ws => { ws.connectToServer(); sockets.push(ws); });
  await page.goto(FIXTURE);
  await page.getByLabel('Room link').fill(link);
  await page.getByLabel('Participant').fill(participant);
  await page.getByRole('button', { name: 'Connect' }).click();
  return page;
}
const opens = (page: Page) => page.locator('#opens');

for (const [a, b] of [['chromium', 'webkit'], ['webkit', 'chromium']]) {
  test(`${a} ↔ ${b}: real y-webrtc signaling opens native channels that carry a large binary value, survive signaling loss, and tear down`, async () => {
    test.setTimeout(150_000);
    const browserA = await engines[a].launch(), browserB = await engines[b].launch();
    try {
      const link = roomLink(createRoomLink('gate-game'), 'http://localhost:5173/');
      const socketsA: WebSocketRoute[] = [], socketsB: WebSocketRoute[] = [];
      const pageA = await open(browserA, link, 'alice', socketsA);
      const pageB = await open(browserB, link, 'bob', socketsB);
      await expect(pageA.locator('#phase')).toHaveText('connected', { timeout: 30_000 });
      await expect(pageB.locator('#phase')).toHaveText('connected', { timeout: 30_000 });
      await expect(opens(pageA)).not.toHaveText('0', { timeout: 60_000 });
      await expect(opens(pageB)).not.toHaveText('0', { timeout: 60_000 });
      expect(socketsA.length + socketsB.length).toBeGreaterThan(0);

      await pageA.getByLabel('Value').fill('hello-from-a');
      await pageA.getByRole('button', { name: 'Publish value' }).click();
      await expect(pageB.locator('#received')).toHaveText('hello-from-a');

      await pageA.getByRole('button', { name: 'Publish large value' }).click();
      await expect(pageB.locator('#large')).toHaveText(expectedLarge(7), { timeout: 30_000 });

      for (const ws of [...socketsA, ...socketsB]) await ws.close();
      await pageB.getByLabel('Value').fill('after-signaling-closed');
      await pageB.getByRole('button', { name: 'Publish value' }).click();
      await expect(pageA.locator('#received')).toHaveText('after-signaling-closed');
      await expect(opens(pageA)).not.toHaveText('0');

      await pageA.getByRole('button', { name: 'Close' }).click();
      await expect(pageA.locator('#phase')).toHaveText('closed');
      await expect(opens(pageB)).toHaveText('0', { timeout: 30_000 });
      await pageB.getByRole('button', { name: 'Close' }).click();
      await expect(pageB.locator('#phase')).toHaveText('closed');
    } finally {
      await browserA.close(); await browserB.close();
    }
  });
}
