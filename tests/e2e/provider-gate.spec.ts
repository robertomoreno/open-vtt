import { test, expect, chromium, webkit, type Browser, type BrowserType, type Page, type WebSocketRoute } from '@playwright/test';
import { createServer, type Socket } from 'node:net';
import WebSocket from 'ws';
import { createRoomLink, roomLink } from '../../src/network/room-link';

const engines: Record<string, BrowserType> = { chromium, webkit };
const FIXTURE = '/tests/e2e/fixtures/provider-gate.html';
const localRelayUrl = process.env.GATHER_LOCAL_SIGNALING_WS;

if (localRelayUrl) {
  const parsed = new URL(localRelayUrl);
  if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error('GATHER_LOCAL_SIGNALING_WS must point to a loopback ws:// server.');
  }
}

function expectedLarge(seed: number): string {
  const bytes = Buffer.alloc(1_500_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + seed * 17 + (i >> 8)) & 255;
  return bytes.toString('base64');
}

async function bridgeLocalRelay(route: WebSocketRoute, url: string): Promise<void> {
  const relay = new WebSocket(url);
  let routeClosed = false;
  let relayOpen = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settleStart: ((error?: Error) => void) | undefined;
  const closeRelay = () => {
    if (relay.readyState === WebSocket.CONNECTING || relay.readyState === WebSocket.CLOSING) relay.terminate();
    else if (relay.readyState === WebSocket.OPEN) relay.close();
  };
  const closeRoute = () => {
    if (routeClosed) return;
    routeClosed = true;
    void route.close();
  };

  route.onClose(() => {
    routeClosed = true;
    if (timer) clearTimeout(timer);
    closeRelay();
    if (!relayOpen) settleStart?.();
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    settleStart = finish;
    timer = setTimeout(() => {
      closeRelay();
      finish(new Error('Timed out connecting to the local signaling relay.'));
      closeRoute();
    }, 3_000);
    relay.addEventListener('open', () => {
      relayOpen = true;
      finish();
    }, { once: true });
    relay.addEventListener('error', () => {
      if (routeClosed) { finish(); return; }
      if (relayOpen) { closeRoute(); return; }
      closeRelay();
      finish(new Error('Could not connect to the local signaling relay.'));
      closeRoute();
    });
    relay.addEventListener('close', () => {
      if (routeClosed) { finish(); return; }
      if (relayOpen) { closeRoute(); return; }
      finish(new Error('Local signaling relay closed before opening.'));
      closeRoute();
    });
  });

  if (routeClosed) return;
  route.onMessage(message => {
    if (relay.readyState === WebSocket.OPEN) relay.send(message);
  });
  relay.addEventListener('message', event => {
    if (!routeClosed) route.send(String(event.data));
  });
}

test('local relay bridge closes a pending loopback connection when the browser route closes', async () => {
  const sockets: Socket[] = [];
  let acceptConnection!: () => void;
  const accepted = new Promise<void>(resolve => { acceptConnection = resolve; });
  const server = createServer(socket => { sockets.push(socket); acceptConnection(); });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Local test server has no TCP address.')); return; }
      resolve(address.port);
    });
  });
  let onClose: Parameters<WebSocketRoute['onClose']>[0] | undefined;
  const route = {
    onMessage() {},
    onClose(handler: Parameters<WebSocketRoute['onClose']>[0]) { onClose = handler; },
    close: async () => {},
    send() {},
  } as unknown as WebSocketRoute;
  const pending = bridgeLocalRelay(route, `ws://127.0.0.1:${port}`);
  const settled = pending.then(() => undefined, () => undefined);

  try {
    await accepted;
    expect(onClose).toBeDefined();
    const closed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Local bridge kept its pending socket open after route closure.')), 1_000);
      sockets[0].once('close', () => { clearTimeout(timer); resolve(); });
    });
    onClose?.(1000, 'browser closed');
    await expect(closed).resolves.toBeUndefined();
    await expect(pending).resolves.toBeUndefined();
  } finally {
    sockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve()));
    await settled;
  }
});

async function open(browser: Browser, link: string, participant: string, sockets: WebSocketRoute[]): Promise<Page> {
  const context = await browser.newContext({ baseURL: 'http://localhost:5173' });
  const page = await context.newPage();
  await page.routeWebSocket(/^wss:/, async ws => {
    sockets.push(ws);
    if (localRelayUrl) await bridgeLocalRelay(ws, localRelayUrl);
    else ws.connectToServer();
  });
  await page.goto(FIXTURE);
  await page.getByLabel('Room link').fill(link);
  await page.getByLabel('Participant').fill(participant);
  await page.getByRole('button', { name: 'Connect' }).click();
  return page;
}
const opens = (page: Page) => page.locator('#opens');

for (const [a, b] of [['chromium', 'webkit'], ['webkit', 'chromium']]) {
  const signalingPath = localRelayUrl ? 'a local y-webrtc-compatible relay' : 'public WSS';
  test(`${a} ↔ ${b}: real Trystero Core signaling over ${signalingPath} opens native channels that carry exact large binary values in both directions, survive signaling loss, and tear down`, async () => {
    test.setTimeout(150_000);
    const browserA = await engines[a].launch(), browserB = await engines[b].launch();
    try {
      const link = roomLink(createRoomLink('gate-game'), 'http://localhost:5173/');
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
