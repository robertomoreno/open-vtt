import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
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
});
