import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createRoomLink } from '../../src/network/room-link';
import { createRoomTransport, type RoomTransport } from '../../src/network/room';
import { createBus, createFakeRtc, createNet, loadCoreJoiner } from './helpers/core-harness';

// Unit-level coverage of the real Trystero Core action scheduler with in-memory signaling and fake native RTC.
// This is NOT public-endpoint or real-browser gate evidence.
const settle = async (until: () => boolean, label: string) => {
  for (let i = 0; i < 600; i++) {
    if (until()) return;
    await vi.advanceTimersByTimeAsync(50);
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('did not settle: ' + label);
};
const flush = async () => { for (let i = 0; i < 20; i++) { await vi.advanceTimersByTimeAsync(0); await new Promise(resolve => setImmediate(resolve)); } };
const big = (i: number, bytes = 100_000) => `${i}:` + 'x'.repeat(bytes);

const transports: RoomTransport[] = [];
async function connectPair() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.stubGlobal('RTCPeerConnection', class {});
  vi.stubGlobal('WebSocket', class {});
  const bus = createBus(), net = createNet(), link = createRoomLink('game-1');
  const docA = new Y.Doc(), docB = new Y.Doc();
  const make = async (name: string, doc: Y.Doc) => {
    const join = await loadCoreJoiner(bus);
    const t = createRoomTransport(doc, link, name, {
      join,
      plan: {
        id: 'wss',
        join,
        base: { appId: 'gather-v2', maxReceiveBytes: 12 * 1024 * 1024 },
        relayConfig: { urls: ['ws://127.0.0.1:4444'] },
        allowsLoopbackCandidateFallback: true,
      },
      native: { RTCPeerConnection: createFakeRtc(net, name) as any },
    });
    transports.push(t);
    return t;
  };
  const A = await make('alice', docA), B = await make('bob', docB);
  await settle(() => A.getView().openRtcConnections === 1 && B.getView().openRtcConnections === 1 && A.getView().presence.length === 2 && B.getView().presence.length === 2, 'connect');
  return { A, B, docA, docB, net };
}
afterEach(() => { for (const t of transports.splice(0)) t.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('room transport on the real Trystero Core scheduler (unit level, in-memory)', () => {
  it('connects two Core rooms through the guarded native runtime and syncs a small update', async () => {
    const { docA, docB } = await connectPair();
    docA.getMap('m').set('hello', 'world');
    await settle(() => docB.getMap('m').get('hello') === 'world', 'small sync');
  });

  it('shares one four-transfer budget between sync offers and presence, and admits presence again once drained', async () => {
    const { A, B, docA, docB, net } = await connectPair();
    net.gate('bob');
    const before = B.getView().presence.find(p => p.id === 'alice')!.seenAt;
    for (let i = 0; i < 5; i++) docA.getMap('m').set('k' + i, big(i, 60_000));
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(net.pending('bob')).toBeGreaterThanOrEqual(6);
    net.open('bob');
    await settle(() => docB.getMap('m').size === 4, 'four admitted transfers complete');
    await flush();
    expect([...docB.getMap('m').keys()].sort()).toEqual(['k0', 'k1', 'k2', 'k3']);
    expect(B.getView().error).toBe('Peer sent too much pending data.');
    expect(B.getView().presence.find(p => p.id === 'alice')!.seenAt).toBe(before);
    expect(B.getView().openRtcConnections).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(B.getView().presence.find(p => p.id === 'alice')!.seenAt).toBeGreaterThan(before);
    expect(A.getView().openRtcConnections).toBe(1);
  });

  it('does not close a peer whose second transfer waits more than 10 s behind a progressing first transfer', async () => {
    const { B, docA, docB, net } = await connectPair();
    net.gate('bob');
    docA.getMap('m').set('k0', big(0)); docA.getMap('m').set('k1', big(1));
    await flush();
    net.deliver('bob', 2);
    await flush();
    for (let i = 0; i < 8; i++) { net.deliver('bob', 1); await vi.advanceTimersByTimeAsync(2_000); await flush(); }
    expect(B.getView().error).toBeNull();
    expect(B.getView().openRtcConnections).toBe(1);
    expect(docB.getMap('m').size).toBe(0);
    for (let i = 0; i < 100 && docB.getMap('m').size < 2; i++) { net.deliver('bob', 2); await vi.advanceTimersByTimeAsync(2_000); await flush(); }
    expect(docB.getMap('m').get('k0')).toBe(big(0));
    expect(docB.getMap('m').get('k1')).toBe(big(1));
    expect(B.getView().error).toBeNull();
  });
});
