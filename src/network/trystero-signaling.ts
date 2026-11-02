import { createTopicStrategy, type JoinRoom, type JoinRoomConfig, type StrategyMessage } from '@trystero-p2p/core';
import { check } from '../game/validation';
import { CONTROL_BYTES, PROBE_TIMEOUT_MS } from './limits';

const MAX_WAITING_PUBLISHES = 64;

type TopicCallback = (topic: string, data: StrategyMessage) => void;
export type RelayClient = {
  subscribe(topic: string, callback: TopicCallback): () => void;
  publish(topic: string, data: StrategyMessage): Promise<void>;
  close(): void;
};

const encoder = new TextEncoder();
const encodedBytes = (value: unknown) => encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;

// Generic WSS topic pub/sub (the y-webrtc-compatible endpoint): carries only discovery and encrypted SDP/ICE.
export function createRelayClient(url: string, Socket: typeof WebSocket = WebSocket): RelayClient {
  check(new URL(url).protocol === 'wss:', 'Signaling URLs must be valid wss:// URLs.');
  const socket = new Socket(url);
  const topics = new Map<string, Set<TopicCallback>>();
  let closed = false;
  let opened = false;
  let used = false;
  const waiting = new Set<{ resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const settleWaiting = (error?: Error) => {
    for (const entry of [...waiting]) {
      waiting.delete(entry);
      clearTimeout(entry.timer);
      if (error) entry.reject(error); else entry.resolve();
    }
  };
  const send = (message: unknown) => {
    const text = JSON.stringify(message);
    check(encoder.encode(text).byteLength <= CONTROL_BYTES, 'Signaling message is too large.');
    socket.send(text);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    topics.clear();
    settleWaiting(new Error('Signaling relay is closed.'));
    socket.close();
  };
  socket.addEventListener('open', () => {
    if (closed) return;
    opened = true;
    if (topics.size > 0) send({ type: 'subscribe', topics: [...topics.keys()] });
    settleWaiting();
  });
  socket.addEventListener('message', event => {
    if (closed || typeof event.data !== 'string' || event.data.length > CONTROL_BYTES || encodedBytes(event.data) > CONTROL_BYTES) return;
    let message: any;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message === null || typeof message !== 'object' || message.type !== 'publish' || typeof message.topic !== 'string' || message.data === undefined) return;
    const callbacks = topics.get(message.topic);
    if (!callbacks) return;
    if (typeof message.data !== 'string' && (message.data === null || typeof message.data !== 'object')) return;
    for (const callback of [...callbacks]) { try { callback(message.topic, message.data); } catch { /* one subscriber must not break another */ } }
  });
  socket.addEventListener('error', () => close());
  socket.addEventListener('close', () => close());
  return {
    subscribe(topic, callback) {
      check(!closed, 'Signaling relay is closed.');
      used = true;
      const callbacks = topics.get(topic) ?? new Set();
      const first = callbacks.size === 0;
      callbacks.add(callback);
      topics.set(topic, callbacks);
      if (first && opened) send({ type: 'subscribe', topics: [topic] });
      let active = true;
      return () => {
        if (!active || closed) return;
        active = false;
        callbacks.delete(callback);
        if (callbacks.size > 0) return;
        topics.delete(topic);
        if (opened) { try { send({ type: 'unsubscribe', topics: [topic] }); } catch { /* socket already closing */ } }
        if (topics.size === 0 && used) close();
      };
    },
    async publish(topic, data) {
      check(!closed, 'Signaling relay is closed.');
      const message = { type: 'publish', topic, data };
      check(encodedBytes(message) <= CONTROL_BYTES, 'Signaling message is too large.');
      if (!opened) {
        check(waiting.size < MAX_WAITING_PUBLISHES, 'Too many signaling messages are waiting.');
        await new Promise<void>((resolve, reject) => {
          const entry = { resolve, reject, timer: setTimeout(() => { waiting.delete(entry); reject(new Error('Signaling relay did not open in time.')); }, PROBE_TIMEOUT_MS) };
          waiting.add(entry);
        });
      }
      check(!closed, 'Signaling relay is closed.');
      send(message);
    },
    close,
  };
}

export function createGatherSignalingStrategy(): JoinRoom<JoinRoomConfig> {
  return createTopicStrategy<RelayClient, JoinRoomConfig>({
    init: config => {
      const urls = config.relayConfig?.urls;
      check(Array.isArray(urls) && urls.length > 0, 'Signaling relay URLs are required.');
      return urls.map(url => createRelayClient(url));
    },
    subscribeTopic: (relay, topic, onMessage) => relay.subscribe(topic, onMessage),
    publishTopic: async (relay, topic, message) => { await relay.publish(topic, message); },
  });
}
