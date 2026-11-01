import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { createRoomLink } from '../../src/network/room-link';
import { createRoomTransport } from '../../src/network/room';
import { KEY_SETTLE_MS } from '../../src/network/limits';

class FakeSocket extends EventTarget {
  static made: string[] = [];
  static open = 0;
  readyState = 0; binaryType = '';
  constructor(url: string) { super(); FakeSocket.made.push(url); FakeSocket.open++; }
  send() {}
  close() { if (this.readyState !== 3) { this.readyState = 3; FakeSocket.open--; } }
}
class FakePc { close() {} }
afterEach(() => { vi.unstubAllGlobals(); FakeSocket.made = []; FakeSocket.open = 0; });
const link = () => createRoomLink('game-1');

describe('room transport', () => {
  it('fails with a safe message when native RTC is unavailable', () => {
    vi.stubGlobal('RTCPeerConnection', undefined);
    const link1 = link();
    const t = createRoomTransport(new Y.Doc(), link1, 'p1');
    const view = t.getView();
    expect(view.phase).toBe('failed');
    expect(view.error).toMatch(/WebRTC/);
    expect(JSON.stringify(view)).not.toContain(link1.secret);
    expect(view.openRtcConnections).toBe(0);
    t.close();
  });

  it('opens signaling only after the async import, then close() tears it down and leaves the document alone', async () => {
    vi.stubGlobal('RTCPeerConnection', FakePc);
    vi.stubGlobal('RTCSessionDescription', class {});
    vi.stubGlobal('RTCIceCandidate', class {});
    vi.stubGlobal('WebSocket', FakeSocket);
    const doc = new Y.Doc();
    const t = createRoomTransport(doc, link(), 'p1');
    expect(t.getView().phase).toBe('looking');
    expect(FakeSocket.made).toEqual([]);
    await vi.waitFor(() => expect(t.getView().presence.map(p => p.id)).toEqual(['p1']));
    expect(t.getView().phase).toBe('looking');
    expect(t.getView().openRtcConnections).toBe(0);
    expect(FakeSocket.made).toEqual(['wss://y-webrtc-eu.fly.dev']);
    expect(t.getView().presence.map(p => p.id)).toEqual(['p1']);
    t.close();
    expect(t.getView().phase).toBe('closed');
    expect(FakeSocket.open).toBe(0);
    doc.getMap('m').set('still', 'usable');
    expect(doc.getMap('m').get('still')).toBe('usable');
    t.close();
  });

  it('close before the import/key work finishes never opens a socket and notifies subscribers once', async () => {
    vi.stubGlobal('RTCPeerConnection', FakePc);
    vi.stubGlobal('RTCSessionDescription', class {});
    vi.stubGlobal('RTCIceCandidate', class {});
    vi.stubGlobal('WebSocket', FakeSocket);
    const t = createRoomTransport(new Y.Doc(), link(), 'p1');
    let calls = 0;
    const off = t.subscribe(() => { calls++; });
    t.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(FakeSocket.made).toEqual([]);
    expect(t.getView().phase).toBe('closed');
    expect(calls).toBe(1);
    off();
  });

  it('heartbeats presence every 5 seconds and stops after close', async () => {
    vi.stubGlobal('RTCPeerConnection', FakePc);
    vi.stubGlobal('RTCSessionDescription', class {});
    vi.stubGlobal('RTCIceCandidate', class {});
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const t = createRoomTransport(new Y.Doc(), link(), 'p1');
    for (let i = 0; i < 100 && t.getView().presence.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(t.getView().presence).toHaveLength(1);
    expect(t.getView().phase).toBe('looking');
    const first = t.getView().presence[0].seenAt;
    vi.advanceTimersByTime(4_999);
    expect(t.getView().presence[0].seenAt).toBe(first);
    vi.advanceTimersByTime(1);
    expect(t.getView().presence[0].seenAt).toBe(first + 5_000);
    t.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  describe('retained awareness bounds', () => {
    const stub = () => {
      vi.stubGlobal('RTCPeerConnection', FakePc);
      vi.stubGlobal('RTCSessionDescription', class {});
      vi.stubGlobal('RTCIceCandidate', class {});
      vi.stubGlobal('WebSocket', FakeSocket);
    };
    const remote = (awareness: Awareness, state: unknown) => {
      const other = new Awareness(new Y.Doc());
      other.setLocalState(state as Record<string, unknown>);
      applyAwarenessUpdate(awareness, encodeAwarenessUpdate(other, [other.clientID]), 'test');
      const id = other.clientID;
      other.destroy();
      return id;
    };
    const connect = async () => {
      stub();
      const doc = new Y.Doc();
      const awareness = new Awareness(doc);
      const t = createRoomTransport(doc, link(), 'local', { awareness });
      await vi.waitFor(() => expect(t.getView().presence).toHaveLength(1));
      return { t, awareness };
    };

    it('keeps valid remote states and drops invalid or oversized ones from retained state and presence', async () => {
      const { t, awareness } = await connect();
      const good = remote(awareness, { id: 'good-peer' });
      const badId = remote(awareness, { id: 'has space!' });
      const noId = remote(awareness, { name: 'x' });
      const huge = remote(awareness, { id: 'huge', pad: 'x'.repeat(8 * 1024) });
      const multibyte = remote(awareness, { id: 'wide', pad: '€'.repeat(3000) });
      const states = awareness.getStates();
      expect(states.has(good)).toBe(true);
      for (const gone of [badId, noId, huge, multibyte]) expect(states.has(gone)).toBe(false);
      expect(t.getView().presence.map(p => p.id)).toEqual(['good-peer', 'local']);
      t.close();
      awareness.destroy();
    });

    it('accepts a state of exactly 8 KiB of UTF-8 and rejects one byte more', async () => {
      const { t, awareness } = await connect();
      const base = JSON.stringify({ id: 'edge', pad: '' }).length;
      const exact = remote(awareness, { id: 'edge', pad: 'x'.repeat(8192 - base) });
      const over = remote(awareness, { id: 'over', pad: 'x'.repeat(8192 - base + 1) });
      expect(awareness.getStates().has(exact)).toBe(true);
      expect(awareness.getStates().has(over)).toBe(false);
      t.close();
      awareness.destroy();
    });

    it('retains at most 32 participants including local and keeps the earliest admitted', async () => {
      const { t, awareness } = await connect();
      const ids = Array.from({ length: 33 }, (_, i) => remote(awareness, { id: `peer-${String(i).padStart(2, '0')}` }));
      const retained = ids.filter(id => awareness.getStates().has(id));
      expect(retained).toEqual(ids.slice(0, 31));
      expect(awareness.getStates().size).toBe(32);
      expect(awareness.getStates().has(awareness.clientID)).toBe(true);
      expect(t.getView().presence).toHaveLength(32);
      t.close();
      awareness.destroy();
    });

    it('keeps awareness metadata bounded under repeated rejected states (live ≤ 32, stateless tombstones ≤ 64)', async () => {
      const { t, awareness } = await connect();
      for (let i = 0; i < 300; i++) remote(awareness, i % 2 ? { id: 'bad id' } : { id: 'big', pad: 'x'.repeat(9000) });
      await Promise.resolve();
      expect(awareness.getStates().size).toBe(1);
      expect(awareness.meta.size).toBeLessThanOrEqual(65);
      t.close();
      awareness.destroy();
    });

    it('bounds metadata immediately for unknown clients announced with a null state (no update event)', async () => {
      const { t, awareness } = await connect();
      for (let i = 0; i < 500; i++) {
        const other = new Awareness(new Y.Doc());
        other.setLocalState(null);
        applyAwarenessUpdate(awareness, encodeAwarenessUpdate(other, [other.clientID]), 'test');
        other.destroy();
        expect(awareness.meta.size).toBeLessThanOrEqual(65);
      }
      t.close();
      awareness.destroy();
    });

    it('does not retain more than 32 live states, and keeps the stale-clock record of an expired participant so a delayed older state is rejected', async () => {
      const { t, awareness } = await connect();
      const other = new Awareness(new Y.Doc());
      other.setLocalState({ id: 'late' });
      const older = encodeAwarenessUpdate(other, [other.clientID]);
      other.setLocalState({ id: 'late', beat: 1 });
      const newer = encodeAwarenessUpdate(other, [other.clientID]);
      applyAwarenessUpdate(awareness, newer, 'test');
      expect(awareness.getStates().has(other.clientID)).toBe(true);
      removeAwarenessStates(awareness, [other.clientID], 'timeout');
      await Promise.resolve();
      expect(awareness.meta.has(other.clientID)).toBe(true);
      applyAwarenessUpdate(awareness, older, 'test');
      expect(awareness.getStates().has(other.clientID)).toBe(false);
      expect(t.getView().presence.map(p => p.id)).toEqual(['local']);
      other.destroy();
      t.close();
      awareness.destroy();
    });
  });

  describe('teardown and reopen', () => {
    it('keeps the room lock until delayed key derivation settles, so an immediate reopen neither fails nor double-opens', async () => {
      vi.stubGlobal('RTCPeerConnection', FakePc);
      vi.stubGlobal('RTCSessionDescription', class {});
      vi.stubGlobal('RTCIceCandidate', class {});
      vi.stubGlobal('WebSocket', FakeSocket);
      const unhandled: unknown[] = [];
      const record = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', record);
      const real = crypto.subtle.importKey.bind(crypto.subtle);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const spy = vi.spyOn(crypto.subtle, 'importKey').mockImplementation(async (...args: any[]) => { await gate; return (real as any)(...args); });
      try {
        const roomLink = link();
        const first = createRoomTransport(new Y.Doc(), roomLink, 'one');
        await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
        first.close();
        expect(first.getView().phase).toBe('closed');
        const second = createRoomTransport(new Y.Doc(), roomLink, 'two');
        expect(second.getView().phase).toBe('looking');
        release();
        await vi.waitFor(() => expect(second.getView().presence).toHaveLength(1));
        expect(second.getView().phase).toBe('looking');
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(unhandled).toEqual([]);
        expect(FakeSocket.open).toBe(1);
        second.close();
        await vi.waitFor(() => expect(FakeSocket.open).toBe(0));
      } finally {
        process.off('unhandledRejection', record);
        spy.mockRestore();
      }
    });

    it('refuses a second live transport for the same room', () => {
      vi.stubGlobal('RTCPeerConnection', FakePc);
      vi.stubGlobal('RTCSessionDescription', class {});
      vi.stubGlobal('RTCIceCandidate', class {});
      vi.stubGlobal('WebSocket', FakeSocket);
      const roomLink = link();
      const first = createRoomTransport(new Y.Doc(), roomLink, 'one');
      const second = createRoomTransport(new Y.Doc(), roomLink, 'two');
      expect(second.getView().phase).toBe('failed');
      first.close();
      second.close();
    });
  });

  it('releases the room lock and owned awareness when the key never settles (rejected or hung derivation), after the settle deadline', async () => {
    vi.stubGlobal('RTCPeerConnection', FakePc);
    vi.stubGlobal('RTCSessionDescription', class {});
    vi.stubGlobal('RTCIceCandidate', class {});
    vi.stubGlobal('WebSocket', FakeSocket);
    const spy = vi.spyOn(crypto.subtle, 'importKey').mockImplementation(() => new Promise<CryptoKey>(() => {}));
    try {
      const roomLink = link();
      const first = createRoomTransport(new Y.Doc(), roomLink, 'one');
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      first.close();
      const blocked = createRoomTransport(new Y.Doc(), roomLink, 'two');
      expect(blocked.getView().phase).toBe('looking');
      spy.mockRestore();
      await vi.advanceTimersByTimeAsync(KEY_SETTLE_MS - 1);
      expect(FakeSocket.open).toBe(0);
      expect(FakeSocket.made).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2);
      vi.useRealTimers();
      await vi.waitFor(() => expect(blocked.getView().presence).toHaveLength(1));
      expect(FakeSocket.open).toBe(1);
      blocked.close();
      await vi.waitFor(() => expect(FakeSocket.open).toBe(0));
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
  });
});
