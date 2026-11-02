import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTROL_BYTES } from '../../src/network/limits';
import { createRelayClient } from '../../src/network/trystero-signaling';

class FakeSocket extends EventTarget {
  static all: FakeSocket[] = [];
  readyState = 0; sent: any[] = []; closed = 0;
  constructor(public url: string) { super(); FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed++; this.readyState = 3; }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  receive(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data: typeof data === 'string' ? data : JSON.stringify(data) })); }
}
afterEach(() => { FakeSocket.all = []; });
const make = () => createRelayClient('wss://signal.example/path', FakeSocket as unknown as typeof WebSocket);

describe('public WSS topic relay client', () => {
  it('sends only generic subscribe, publish and unsubscribe envelopes after the socket opens', async () => {
    const relay = make();
    const got: unknown[] = [];
    const off = relay.subscribe('topic-a', (topic, data) => got.push([topic, data]));
    const socket = FakeSocket.all[0];
    expect(socket.sent).toEqual([]);
    socket.open();
    await relay.publish('topic-a', 'hello');
    await relay.publish('topic-b', '{"x":1}');
    off();
    expect(socket.sent).toEqual([
      { type: 'subscribe', topics: ['topic-a'] },
      { type: 'publish', topic: 'topic-a', data: 'hello' },
      { type: 'publish', topic: 'topic-b', data: '{"x":1}' },
      { type: 'unsubscribe', topics: ['topic-a'] },
    ]);
  });

  it('routes only published data for a subscribed topic', () => {
    const relay = make();
    const got: unknown[] = [];
    relay.subscribe('t', (topic, data) => got.push([topic, data]));
    const socket = FakeSocket.all[0]; socket.open();
    socket.receive({ type: 'publish', topic: 't', data: 'one' });
    socket.receive({ type: 'publish', topic: 'other', data: 'nope' });
    socket.receive({ type: 'pong' });
    socket.receive({ type: 'publish', topic: 't' });
    socket.receive({ type: 'publish', topic: 7, data: 'x' });
    socket.receive('not json');
    socket.receive({ type: 'publish', topic: 't', data: 'x'.repeat(CONTROL_BYTES + 1) });
    socket.receive({ type: 'publish', topic: 't', data: { n: 1 } });
    expect(got).toEqual([['t', 'one'], ['t', { n: 1 }]]);
  });

  it('rejects publishing an encoded control message over 128 KiB', async () => {
    const relay = make();
    relay.subscribe('t', () => {});
    const socket = FakeSocket.all[0]; socket.open();
    await expect(relay.publish('t', 'x'.repeat(CONTROL_BYTES))).rejects.toThrow();
    expect(socket.sent).toEqual([{ type: 'subscribe', topics: ['t'] }]);
  });

  it('closes the socket and ignores later messages once the last subscription is gone', () => {
    const relay = make();
    const got: unknown[] = [];
    const offA = relay.subscribe('a', (_t, d) => got.push(d));
    const offB = relay.subscribe('b', (_t, d) => got.push(d));
    const socket = FakeSocket.all[0]; socket.open();
    offA();
    expect(socket.closed).toBe(0);
    offB(); offB();
    expect(socket.closed).toBe(1);
    socket.receive({ type: 'publish', topic: 'a', data: 'late' });
    expect(got).toEqual([]);
  });

  it('close() is idempotent and a socket closed before opening is never used', async () => {
    const relay = make();
    relay.subscribe('t', () => {});
    relay.close(); relay.close();
    const socket = FakeSocket.all[0];
    expect(socket.closed).toBe(1);
    socket.open();
    await expect(relay.publish('t', 'x')).rejects.toThrow();
    expect(socket.sent).toEqual([]);
  });

  it('rejects non-wss relay URLs', () => {
    expect(() => createRelayClient('ws://insecure.example', FakeSocket as unknown as typeof WebSocket)).toThrow();
  });
});
