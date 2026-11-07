#!/usr/bin/env node
// Local signaling relay for Gather's dev/E2E testing.
//
// Speaks the same JSON topic protocol as the upstream y-webrtc 10.3.0 relay
// (subscribe / unsubscribe / publish) that src/network/trystero-signaling.ts
// expects. Bound to loopback only. NOT a production service: no auth, no TLS,
// no persistence. Used by `npm run signal:start` / `npm run signal:stop` and
// by the Playwright provider gate via GATHER_LOCAL_SIGNALING_WS.
//
// Protocol (per message, JSON):
//   { type:'subscribe', topics:[...] }   -> register interest
//   { type:'unsubscribe', topics:[...] } -> drop interest
//   { type:'publish', topic, data }     -> fan out to subscribers (incl. sender? no: y-webrtc echoes to others)
//
// This is a thin relay: it forwards published messages to every other client
// subscribed to that topic. No game state is stored.

import { WebSocketServer } from 'ws';
import http from 'node:http';
import { writeFileSync, unlinkSync } from 'node:fs';

const PORT = Number(process.env.PORT) || 4444;
const HOST = process.env.HOST || '127.0.0.1';
const PID_FILE = process.env.SIGNALING_PID_FILE || '.signaling.pid';
const MAX_FRAME_BYTES = 128 * 1024;

const wsOpen = 1;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('okay');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

/** Map topic -> Set<socket> */
const topics = new Map();

function send(conn, message) {
  if (conn.readyState !== 0 && conn.readyState !== wsOpen) {
    try { conn.close(); } catch {}
    return;
  }
  try {
    conn.send(JSON.stringify(message));
  } catch {
    try { conn.close(); } catch {}
  }
}

let clientCount = 0;
function onConnection(conn) {
  const id = ++clientCount;
  console.log(`[relay] client ${id} connected (total ${wss.clients.size})`);
  const subscribed = new Set();
  const pingInterval = setInterval(() => {
    if (conn.readyState === wsOpen) {
      try { conn.ping(); } catch { conn.close(); }
    }
  }, 30000);
  conn.on('pong', () => {});
  conn.on('close', () => {
    console.log(`[relay] client ${id} disconnected`);
    clearInterval(pingInterval);
    subscribed.forEach((topicName) => {
      const subs = topics.get(topicName);
      if (subs) {
        subs.delete(conn);
        if (subs.size === 0) topics.delete(topicName);
      }
    });
    subscribed.clear();
  });
  conn.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'subscribe' && Array.isArray(msg.topics)) {
      for (const t of msg.topics) {
        if (typeof t !== 'string') continue;
        if (!topics.has(t)) topics.set(t, new Set());
        topics.get(t).add(conn);
        subscribed.add(t);
      }
      console.log(`[relay] subscribe topics=${msg.topics.join(',')} (clients=${topics.size} topics)`);
    } else if (msg.type === 'unsubscribe' && Array.isArray(msg.topics)) {
      for (const t of msg.topics) {
        const subs = topics.get(t);
        if (subs) { subs.delete(conn); if (subs.size === 0) topics.delete(t); }
        subscribed.delete(t);
      }
      console.log(`[relay] unsubscribe topics=${msg.topics.join(',')}`);
    } else if (msg.type === 'publish' && typeof msg.topic === 'string') {
      const subs = topics.get(msg.topic);
      let delivered = 0;
      if (subs) {
        for (const c of subs) {
          if (c !== conn) { send(c, { type: 'publish', topic: msg.topic, data: msg.data }); delivered++; }
        }
      }
      console.log(`[relay] publish topic=${msg.topic} -> ${delivered} client(s)`);
    }
  });
}

wss.on('connection', onConnection);
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

server.listen(PORT, HOST, () => {
  try { writeFileSync(PID_FILE, String(process.pid)); } catch {}
  console.log(`Gather signaling relay listening on ${HOST}:${PORT} (pid ${process.pid})`);
  console.log('Stop with: npm run signal:stop');
});

function shutdown() {
  try { unlinkSync(PID_FILE); } catch {}
  try { server.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);