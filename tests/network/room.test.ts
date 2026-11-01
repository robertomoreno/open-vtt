import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { createRoomLink } from '../../src/network/room-link';
import { createRoomTransport } from '../../src/network/room';

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
    await vi.waitFor(() => expect(t.getView().phase).toBe('connected'));
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
    for (let i = 0; i < 100 && t.getView().phase !== 'connected'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(t.getView().phase).toBe('connected');
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
      await vi.waitFor(() => expect(t.getView().phase).toBe('connected'));
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
  });
});
