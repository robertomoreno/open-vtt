import { test, expect, chromium, webkit, type Browser, type BrowserType, type Page, type WebSocketRoute } from '@playwright/test';
import { createRoomLink, roomLink } from '../../src/network/room-link';
import { APP_URL, LOCAL_RELAY_URL } from './config';

const engines: Record<string, BrowserType> = { chromium, webkit };
const FIXTURE = '/tests/e2e/fixtures/provider-gate.html';
const localRelayPattern = new RegExp(`^${LOCAL_RELAY_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

function expectedLarge(seed: number): string {
  const bytes = Buffer.alloc(1_500_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + seed * 17 + (i >> 8)) & 255;
  return bytes.toString('base64');
}

async function open(browser: Browser, link: string, participant: string, sockets: WebSocketRoute[]): Promise<Page> {
  const context = await browser.newContext({ baseURL: APP_URL });
  const page = await context.newPage();
  // Intercept only the loopback signaling connection so the test can close it
  // to prove native channels survive signaling loss. It is not bridged: the
  // browser talks directly to the local relay.
  await page.routeWebSocket(localRelayPattern, ws => {
    sockets.push(ws);
    ws.connectToServer();
  });
  await page.goto(FIXTURE);
  await page.getByLabel('Room link').fill(link);
  await page.getByLabel('Participant').fill(participant);
  await page.getByRole('button', { name: 'Connect' }).click();
  return page;
}
const opens = (page: Page) => page.locator('#opens');

for (const [a, b] of [['chromium', 'webkit'], ['webkit', 'chromium']]) {
  test(`${a} ↔ ${b}: real Trystero Core signaling over the local relay opens native channels that carry exact large binary values in both directions, survive signaling loss, and tear down`, async () => {
    test.setTimeout(150_000);
    const browserA = await engines[a].launch(), browserB = await engines[b].launch();
    try {
      const link = roomLink(createRoomLink('gate-game'), `${APP_URL}/`);
      const socketsA: WebSocketRoute[] = [], socketsB: WebSocketRoute[] = [];
      const pageA = await open(browserA, link, 'alice', socketsA);
      const pageB = await open(browserB, link, 'bob', socketsB);
      await expect(pageA.locator('#phase')).toHaveText(/looking|connected/, { timeout: 30_000 });
      await expect(opens(pageA)).not.toHaveText('0', { timeout: 60_000 });
      await expect(opens(pageB)).not.toHaveText('0', { timeout: 60_000 });
      await expect(pageA.locator('#phase')).toHaveText('connected');
      await expect(pageB.locator('#phase')).toHaveText('connected');
      expect(socketsA.length + socketsB.length).toBeGreaterThan(0);

      const publish = async (page: Page, value: string) => {
        await page.getByLabel('Value').fill(value);
        await page.getByRole('button', { name: 'Publish value' }).click();
      };
      const publishLarge = async (page: Page, seed: number) => {
        await page.getByLabel('Seed').fill(String(seed));
        await page.getByRole('button', { name: 'Publish large value' }).click();
      };
      const exactLarge = async (page: Page, key: string, seed: number) => {
        await expect(page.locator(`[data-large="${key}"]`)).toHaveText(expectedLarge(seed), { timeout: 30_000 });
      };

      await publish(pageA, 'hello-from-a');
      await expect(pageB.locator('#received')).toContainText('small-alice=hello-from-a');
      await publishLarge(pageA, 7);
      await exactLarge(pageB, 'large-alice', 7);

      for (const ws of [...socketsA, ...socketsB]) await ws.close();

      await publish(pageB, 'after-closed-from-b');
      await expect(pageA.locator('#received')).toContainText('small-bob=after-closed-from-b');
      await publish(pageA, 'after-closed-from-a');
      await expect(pageB.locator('#received')).toContainText('small-alice=after-closed-from-a');
      await publishLarge(pageB, 11);
      await exactLarge(pageA, 'large-bob', 11);
      await publishLarge(pageA, 13);
      await exactLarge(pageB, 'large-alice', 13);
      await expect(opens(pageA)).not.toHaveText('0');
      await expect(opens(pageB)).not.toHaveText('0');

      await pageA.getByRole('button', { name: 'Close' }).click();
      await expect(pageA.locator('#phase')).toHaveText('closed');
      await expect(opens(pageB)).toHaveText('0', { timeout: 30_000 });
      await expect(pageB.locator('#phase')).toHaveText('looking');
      await pageB.getByRole('button', { name: 'Close' }).click();
      await expect(pageB.locator('#phase')).toHaveText('closed');
    } finally {
      await browserA.close(); await browserB.close();
    }
  });
}
