// Availability probe: opens one wss: socket, sends a y-webrtc-style ping and waits for the pong.
// It never subscribes to a topic or sends SDP, game state, or credentials, and prints only the host.
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
const socket = new WebSocket(url.href);
const timer = setTimeout(() => { socket.close(); fail(`no pong from ${label} within ${PROBE_TIMEOUT_MS / 1000}s`); }, PROBE_TIMEOUT_MS);
socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'ping' })));
socket.addEventListener('message', event => {
  let message;
  try { message = JSON.parse(String(event.data)); } catch { return; }
  if (message?.type === 'pong') {
    clearTimeout(timer);
    console.log(`signaling probe ok: ${label} answered ping with pong`);
    socket.close();
    process.exit(0);
  }
});
socket.addEventListener('error', () => { clearTimeout(timer); fail(`could not connect to ${label}`); });
socket.addEventListener('close', () => { clearTimeout(timer); fail(`${label} closed before answering`); });
