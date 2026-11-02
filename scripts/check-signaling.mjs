// Availability probe: opens one wss: socket, subscribes to a random temporary topic and waits for its own publish to come back.
// It sends only a random topic and random bytes (no credentials, SDP, ICE or game state) and prints only the host.
import { randomUUID } from 'node:crypto';

const PROBE_TIMEOUT_MS = 8_000;
const input = process.argv[2];

function fail(message) {
  console.error(`signaling probe failed: ${message}`);
  process.exit(1);
}

let url;
try {
  url = new URL(input ?? '');
} catch {
  fail('pass one wss:// URL as the first argument');
}
if (url.protocol !== 'wss:' || !url.host) fail('the URL must use wss://');
if (typeof WebSocket !== 'function') fail('this Node.js has no WebSocket client (use Node 22.12+)');

const label = `wss://${url.host}`;
const topic = `gather-probe-${randomUUID()}`;
const data = randomUUID();
const socket = new WebSocket(url.href);
const timer = setTimeout(() => { socket.close(); fail(`no topic roundtrip from ${label} within ${PROBE_TIMEOUT_MS / 1000}s`); }, PROBE_TIMEOUT_MS);
socket.addEventListener('open', () => {
  socket.send(JSON.stringify({ type: 'subscribe', topics: [topic] }));
  socket.send(JSON.stringify({ type: 'publish', topic, data }));
});
socket.addEventListener('message', event => {
  let message;
  try { message = JSON.parse(String(event.data)); } catch { return; }
  if (message?.type === 'publish' && message.topic === topic && message.data === data) {
    clearTimeout(timer);
    socket.send(JSON.stringify({ type: 'unsubscribe', topics: [topic] }));
    console.log(`signaling probe ok: ${label} completed a temporary topic subscribe/publish roundtrip`);
    socket.close();
    process.exit(0);
  }
});
socket.addEventListener('error', () => { clearTimeout(timer); fail(`could not connect to ${label}`); });
socket.addEventListener('close', () => { clearTimeout(timer); fail(`${label} closed before the roundtrip completed`); });
