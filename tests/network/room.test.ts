import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { roomNetworkConfig, rtcConfiguration } from '../../src/network/config';
import { createRoomLink } from '../../src/network/room-link';
import { createRoomTransport, type RoomTransportOptions } from '../../src/network/room';

class FakeChannel extends EventTarget {
  label = 'data'; ordered = true; maxRetransmits: number | null = null; maxPacketLifeTime: number | null = null;
  readyState = 'connecting'; bufferedAmount = 0; bufferedAmountLowThreshold = 0; binaryType = 'blob';
  send() {} close() { this.readyState = 'closed'; }
  open() { this.readyState = 'open'; this.dispatchEvent(new Event('open')); }
}
class FakePc extends EventTarget {
  static all: FakePc[] = []; channels: FakeChannel[] = []; closed = 0;
  constructor() { super(); FakePc.all.push(this); }
  createDataChannel() { const c = new FakeChannel(); this.channels.push(c); return c; }
  close() { this.closed++; for (const c of this.channels) c.close(); }
}
type Action = { send: ReturnType<typeof vi.fn>; onMessage: ((data: any, ctx: { peerId: string }) => void) | null; onReceive: ((ctx: any) => boolean) | null; onReceiveProgress: ((p: number, ctx: { peerId: string }) => void) | null };
function fakeJoin() {
  const state = {
    configs: [] as any[], roomIds: [] as string[], callbacks: undefined as any, actions: {} as Record<string, Action>,
    room: undefined as any, leaves: 0, peers: {} as Record<string, { close: ReturnType<typeof vi.fn> }>,
  };
  const join = (config: any, roomId: string, callbacks?: any) => {
    state.configs.push(config); state.roomIds.push(roomId); state.callbacks = callbacks;
    state.room = {
      makeAction: (name: string, cfg?: any) => (state.actions[name] = { send: vi.fn(async () => {}), onMessage: cfg?.onMessage ?? null, onReceive: cfg?.onReceive ?? null, onReceiveProgress: cfg?.onReceiveProgress ?? null }),
      getPeers: () => state.peers, leave: async () => { state.leaves++; },
      onPeerJoin: null, onPeerLeave: null,
    };
    return state.room;
  };
  return { join: join as unknown as NonNullable<RoomTransportOptions['join']>, state };
}
const stubBrowser = () => {
  vi.stubGlobal('RTCPeerConnection', FakePc);
  vi.stubGlobal('WebSocket', class {});
};
const link = () => createRoomLink('game-1');
const start = async (doc = new Y.Doc(), participant = 'me') => {
  stubBrowser();
  const fake = fakeJoin();
  const t = createRoomTransport(doc, link(), participant, { join: fake.join, native: { RTCPeerConnection: FakePc as any } });
  await vi.waitFor(() => expect(fake.state.room).toBeDefined());
  const join = (peerId: string) => { fake.state.peers[peerId] = { close: vi.fn() }; fake.state.room.onPeerJoin?.(peerId); };
  return { doc, t, ...fake, join };
};
const ctx = (peerId: string, byteLength: number, t?: number) => { const controller = new AbortController(); return { peerId, byteLength, kind: 'message', signal: controller.signal, controller, ...(t === undefined ? {} : { metadata: { t } }) }; };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); FakePc.all = []; });

describe('room transport', () => {
  it('fails with a safe message when native RTC is unavailable', () => {
    vi.stubGlobal('RTCPeerConnection', undefined);
    const l = link();
    const t = createRoomTransport(new Y.Doc(), l, 'p1');
    const view = t.getView();
    expect(view.phase).toBe('failed');
    expect(view.error).toMatch(/WebRTC/);
    expect(JSON.stringify(view)).not.toContain(l.secret);
    t.close();
  });

  it('joins only with the approved bounded config and the link secret as signaling password', async () => {
    const { state, t } = await start();
    const config = state.configs[0];
    expect(state.configs).toHaveLength(1);
    expect(config.appId).toBe('gather-v2');
    expect(config.maxReceiveBytes).toBe(8 * 1024 * 1024);
    expect(config.relayConfig).toEqual({ urls: roomNetworkConfig.signaling });
    expect(config.rtcConfig).toBe(roomNetworkConfig.rtc);
    expect(config.rtcConfig.iceServers).toEqual(rtcConfiguration.iceServers);
    expect(config.rtcConfig.iceServers.flatMap((s: any) => s.urls).every((u: string) => u.startsWith('stun:'))).toBe(true);
    expect(typeof config.rtcPolyfill).toBe('function');
    expect(config.password).toHaveLength(43);
    expect(JSON.stringify(t.getView())).not.toContain(config.password);
    t.close();
  });

  it('sends the full state only to a joining peer and later updates to every connected peer except their origin', async () => {
    const doc = new Y.Doc();
    doc.getMap('m').set('before', 1);
    const { state, join, t } = await start(doc);
    const sync = state.actions['gather-sync-v2'];
    join('peer-a');
    expect(sync.send).toHaveBeenCalledTimes(1);
    expect(sync.send.mock.calls[0][1]).toMatchObject({ target: 'peer-a', metadata: { t: expect.any(Number) } });
    const copy = new Y.Doc(); Y.applyUpdate(copy, sync.send.mock.calls[0][0]);
    expect(copy.getMap('m').get('before')).toBe(1);
    join('peer-b');
    sync.send.mockClear();
    doc.getMap('m').set('local', 2);
    expect(sync.send).toHaveBeenCalledTimes(1);
    expect(sync.send.mock.calls[0][1]).toMatchObject({ target: ['peer-a', 'peer-b'], metadata: { t: expect.any(Number) } });
    sync.send.mockClear();
    const remote = new Y.Doc(); remote.getMap('m').set('remote', 3);
    sync.onMessage!(Y.encodeStateAsUpdate(remote), { peerId: 'peer-a' });
    expect(doc.getMap('m').get('remote')).toBe(3);
    expect(sync.send.mock.calls.flatMap(c => c[1].target)).toEqual(['peer-b']);
    t.close();
  });

  it('treats malformed remote Yjs bytes as a peer fault without changing the document or failing the room', async () => {
    const doc = new Y.Doc();
    const { state, join, t } = await start(doc);
    join('peer-a');
    state.actions['gather-sync-v2'].onMessage!(new Uint8Array([255, 255, 255, 1]), { peerId: 'peer-a' });
    state.actions['gather-sync-v2'].onMessage!('not bytes', { peerId: 'peer-a' });
    expect(t.getView().phase).toBe('looking');
    expect(t.getView().error).toBe('Peer sent an invalid update.');
    expect(doc.getMap('m').size).toBe(0);
    t.close();
  });

  it('reports connected only when a native data channel is actually open', async () => {
    const { state, join, t } = await start();
    join('peer-a');
    expect(t.getView().phase).toBe('looking');
    const pc = new state.configs[0].rtcPolyfill();
    pc.createDataChannel('data');
    expect(t.getView().openRtcConnections).toBe(0);
    FakePc.all[0].channels[0].open();
    expect(t.getView().openRtcConnections).toBe(1);
    expect(t.getView().phase).toBe('connected');
    t.close();
    expect(t.getView().phase).toBe('closed');
    expect(t.getView().openRtcConnections).toBe(0);
  });

  it('admits only a version-2 handshake with a valid opaque participant ID and limits pending handshakes to 8', async () => {
    const { state, t } = await start(new Y.Doc(), 'me');
    const hs = state.callbacks.onPeerHandshake as (id: string, send: (d: any) => Promise<void>, receive: () => Promise<{ data: any }>, init: boolean) => Promise<void>;
    const sent: any[] = [];
    const send = async (d: any) => { sent.push(d); };
    await hs('p1', send, async () => ({ data: { v: 2, id: 'alice' } }), true);
    expect(sent).toEqual([{ v: 2, id: 'me' }]);
    await expect(hs('p2', send, async () => ({ data: { v: 1, id: 'bob' } }), true)).rejects.toThrow();
    await expect(hs('p3', send, async () => ({ data: { v: 2, id: 'has space' } }), true)).rejects.toThrow();
    await expect(hs('p4', send, async () => ({ data: { v: 2, id: 'x', extra: 1 } }), true)).rejects.toThrow();
    const blocked = Array.from({ length: 8 }, (_, i) => hs(`q${i}`, send, () => new Promise(() => {}), true));
    await expect(hs('q9', send, async () => ({ data: { v: 2, id: 'z' } }), true)).rejects.toThrow();
    void blocked;
    t.close();
  });

  describe('presence', () => {
    it('heartbeats every 5 seconds, timestamps locally, expires after 30 seconds and stops on close', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
      const { state, join, t } = await start();
      join('peer-a');
      const presence = state.actions['gather-presence-v2'];
      await vi.advanceTimersByTimeAsync(5_000);
      expect(presence.send.mock.calls.at(-1)![0]).toEqual({ id: 'me' });
      const sends = presence.send.mock.calls.length;
      state.callbacks.onPeerHandshake('peer-a', async () => {}, async () => ({ data: { v: 2, id: 'alice' } }), true);
      await vi.advanceTimersByTimeAsync(0);
      presence.onMessage!({ id: 'alice' }, { peerId: 'peer-a' });
      expect(t.getView().presence.map(p => p.id)).toEqual(['alice', 'me']);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(t.getView().presence.map(p => p.id)).toEqual(['me']);
      t.close();
      expect(vi.getTimerCount()).toBe(0);
      expect(presence.send.mock.calls.length).toBeGreaterThan(sends);
      const after = presence.send.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(presence.send.mock.calls.length).toBe(after);
    });

    it('ignores oversized, malformed and mismatched presence and rate-limits a peer to a burst of 20', async () => {
      const { state, join, t } = await start();
      join('peer-a');
      await state.callbacks.onPeerHandshake('peer-a', async () => {}, async () => ({ data: { v: 2, id: 'alice' } }), true);
      const presence = state.actions['gather-presence-v2'];
      presence.onMessage!({ id: 'alice', pad: 'x'.repeat(8 * 1024) }, { peerId: 'peer-a' });
      presence.onMessage!({ id: 'mallory' }, { peerId: 'peer-a' });
      presence.onMessage!('alice', { peerId: 'peer-a' });
      expect(t.getView().presence.map(p => p.id)).toEqual(['me']);
      for (let i = 0; i < 25; i++) presence.onMessage!({ id: 'alice' }, { peerId: 'peer-a' });
      expect(t.getView().presence.map(p => p.id)).toEqual(['alice', 'me']);
      t.close();
    });
  });

  describe('pending-transfer admission', () => {
    it('rejects one payload over 2 MiB, a fifth pending transfer per peer, and over 16 MiB aggregate', async () => {
      const { state, join, t } = await start();
      join('peer-a'); join('peer-b'); join('peer-c');
      const receive = state.actions['gather-sync-v2'].onReceive!;
      expect(receive(ctx('peer-a', 2 * 1024 * 1024 + 1))).toBe(false);
      const held = Array.from({ length: 4 }, () => ctx('peer-a', 1024));
      expect(held.map(c => receive(c))).toEqual([true, true, true, true]);
      expect(receive(ctx('peer-a', 1024))).toBe(false);
      held[0].controller.abort();
      expect(receive(ctx('peer-a', 1024))).toBe(true);
      // Seven 2-MiB transfers plus peer-a's 4 KiB fit; the eighth 2-MiB transfer exceeds 16 MiB.
      expect([1, 2, 3, 4].map(id => receive(ctx('peer-b', 2 * 1024 * 1024, id)))).toEqual([true, true, true, true]);
      expect([1, 2, 3].map(id => receive(ctx('peer-c', 2 * 1024 * 1024, id)))).toEqual([true, true, true]);
      expect(receive(ctx('peer-c', 2 * 1024 * 1024, 4))).toBe(false);
      expect(t.getView().phase).toBe('looking');
      t.close();
    });

    it('closes only the silent peer after 10 seconds without progress, and progress extends the deadline', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
      const { state, join, t } = await start();
      join('peer-a'); join('peer-b');
      const sync = state.actions['gather-sync-v2'];
      sync.onReceive!(ctx('peer-a', 100_000, 1));
      sync.onReceive!(ctx('peer-b', 100_000, 1));
      await vi.advanceTimersByTimeAsync(9_000);
      sync.onReceiveProgress!(0.5, { peerId: 'peer-b', metadata: { t: 1 } } as any);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(state.peers['peer-a'].close).toHaveBeenCalledTimes(1);
      expect(state.peers['peer-b'].close).not.toHaveBeenCalled();
      expect(t.getView().error).toBe('Peer transfer expired.');
      await vi.advanceTimersByTimeAsync(9_000);
      expect(state.peers['peer-b'].close).toHaveBeenCalledTimes(1);
      t.close();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('leaves no timer once a pending transfer settles', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
      const { state, join, t } = await start();
      join('peer-a');
      const c = ctx('peer-a', 1000);
      state.actions['gather-sync-v2'].onReceive!(c);
      const before = vi.getTimerCount();
      c.controller.abort();
      expect(vi.getTimerCount()).toBe(before - 1);
      t.close();
    });
  });


  describe('shared admission across every action path', () => {
    const setup = async () => {
      const r = await start();
      for (const id of ['a', 'b', 'c', 'd', 'e']) r.join('peer-' + id);
      return { ...r, sync: r.state.actions['gather-sync-v2'], presence: r.state.actions['gather-presence-v2'] };
    };

    it('counts presence and sync transfers against the same four-per-peer and 16 MiB budgets', async () => {
      const { sync, presence, t } = await setup();
      expect([sync.onReceive!(ctx('peer-a', 10, 1)), sync.onReceive!(ctx('peer-a', 10, 2)), presence.onReceive!(ctx('peer-a', 10, 3)), presence.onReceive!(ctx('peer-a', 10, 4))]).toEqual([true, true, true, true]);
      expect(presence.onReceive!(ctx('peer-a', 10, 5))).toBe(false);
      expect(sync.onReceive!(ctx('peer-a', 10, 6))).toBe(false);
      expect(presence.onReceive!(ctx('peer-b', 8 * 1024 + 1, 1))).toBe(false);
      expect([sync.onReceive!(ctx('peer-b', 2 * 1024 * 1024, 1)), sync.onReceive!(ctx('peer-c', 2 * 1024 * 1024, 1)), sync.onReceive!(ctx('peer-d', 2 * 1024 * 1024, 1))]).toEqual([true, true, true]);
      expect(sync.onReceive!(ctx('peer-e', 2 * 1024 * 1024 - 100, 1))).toBe(true);
      // A second 2-MiB transfer on each peer fills the 16 MiB aggregate; the next byte is refused.
      expect([sync.onReceive!(ctx('peer-b', 2 * 1024 * 1024, 2)), sync.onReceive!(ctx('peer-c', 2 * 1024 * 1024, 2)), sync.onReceive!(ctx('peer-d', 2 * 1024 * 1024, 2)), sync.onReceive!(ctx('peer-e', 2 * 1024 * 1024, 2))]).toEqual([true, true, true, true]);
      expect(presence.onReceive!(ctx('peer-e', 1024, 3))).toBe(false);
      t.close();
    });

    it('expires a silent presence transfer and closes only that peer', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
      const { state, presence, t } = await setup();
      presence.onReceive!(ctx('peer-a', 100, 1));
      await vi.advanceTimersByTimeAsync(10_001);
      expect(state.peers['peer-a'].close).toHaveBeenCalledTimes(1);
      expect(state.peers['peer-b'].close).not.toHaveBeenCalled();
      t.close();
    });

    it('extends only the transfer that made progress, never its stalled siblings', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
      const { state, sync, t } = await setup();
      const stalled = ctx('peer-a', 1000, 1), moving = ctx('peer-a', 1000, 2);
      sync.onReceive!(stalled); sync.onReceive!(moving);
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(4_000);
        sync.onReceiveProgress!(0.5, { peerId: 'peer-a', metadata: { t: 2 } } as any);
      }
      expect(state.peers['peer-a'].close).toHaveBeenCalledTimes(1);
      expect(stalled.signal.aborted).toBe(false);
      t.close();
    });

    it('does not extend any deadline for progress it cannot attribute', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
      const { state, sync, t } = await setup();
      sync.onReceive!(ctx('peer-a', 1000, 1));
      await vi.advanceTimersByTimeAsync(9_000);
      sync.onReceiveProgress!(0.5, { peerId: 'peer-a' });
      sync.onReceiveProgress!(0.5, { peerId: 'peer-a', metadata: { t: 99 } } as any);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(state.peers['peer-a'].close).toHaveBeenCalledTimes(1);
      t.close();
    });

    it('rejects a transfer that reuses a pending transfer id from the same peer', async () => {
      const { sync, t } = await setup();
      expect(sync.onReceive!(ctx('peer-a', 10, 1))).toBe(true);
      expect(sync.onReceive!(ctx('peer-a', 10, 1))).toBe(false);
      t.close();
    });

    for (const order of ['leave-then-abort', 'abort-then-leave'] as const) {
      it(`releases a reservation exactly once (${order})`, async () => {
        const { state, sync, t } = await setup();
        const first = ctx('peer-a', 2 * 1024 * 1024, 1);
        sync.onReceive!(first);
        if (order === 'leave-then-abort') { state.room.onPeerLeave('peer-a'); first.controller.abort(); }
        else { first.controller.abort(); state.room.onPeerLeave('peer-a'); }
        // Eight 2-MiB transfers exactly fill the 16 MiB aggregate; a stale reservation would
        // make the last one fail, and the next peer's transfer must fail in either case.
        const admitted = ['b', 'c', 'd', 'e'].flatMap(id => [sync.onReceive!(ctx('peer-' + id, 2 * 1024 * 1024, 1)), sync.onReceive!(ctx('peer-' + id, 2 * 1024 * 1024, 2))]);
        expect(admitted).toEqual([true, true, true, true, true, true, true, true]);
        state.room.onPeerJoin('peer-f');
        expect(sync.onReceive!(ctx('peer-f', 2 * 1024 * 1024, 1))).toBe(false);
        t.close();
      });
    }
  });

  describe('lifecycle', () => {
    it('close() marks closed first, leaves the Trystero room once, closes native objects and keeps the document usable', async () => {
      const doc = new Y.Doc();
      const { state, t } = await start(doc);
      const pc = new state.configs[0].rtcPolyfill();
      pc.createDataChannel('data');
      FakePc.all[0].channels[0].open();
      let phaseAtLeave: string | undefined;
      state.room.leave = async () => { phaseAtLeave = t.getView().phase; state.leaves++; };
      t.close(); t.close();
      expect(phaseAtLeave).toBe('closed');
      expect(state.leaves).toBe(1);
      expect(FakePc.all[0].closed).toBe(1);
      doc.getMap('m').set('still', 'usable');
      expect(doc.getMap('m').get('still')).toBe('usable');
      expect(state.actions['gather-sync-v2'].send).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ target: expect.anything() }));
    });

    it('close before the async start finishes never joins, and notifies subscribers once', async () => {
      stubBrowser();
      const fake = fakeJoin();
      const t = createRoomTransport(new Y.Doc(), link(), 'p1', { join: fake.join });
      let calls = 0;
      t.subscribe(() => { calls++; });
      t.close();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(fake.state.configs).toHaveLength(0);
      expect(calls).toBe(1);
    });

    it('does not use BroadcastChannel', async () => {
      const constructed = vi.fn();
      vi.stubGlobal('BroadcastChannel', class { constructor() { constructed(); } });
      const { t } = await start();
      t.close();
      expect(constructed).not.toHaveBeenCalled();
    });

    it('turns a join failure into a safe failed phase', async () => {
      stubBrowser();
      const t = createRoomTransport(new Y.Doc(), link(), 'p1', { join: () => { throw new Error('wss://secret.example sdp'); } });
      await vi.waitFor(() => expect(t.getView().phase).toBe('failed'));
      expect(t.getView().error).toBe('The room transport could not start.');
      t.close();
    });
  });
});
