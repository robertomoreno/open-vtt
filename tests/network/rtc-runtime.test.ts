import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeBinaryFrames } from '../../src/network/binary-framing';
import { createBoundedRtcRuntime, type RtcConstructors } from '../../src/network/rtc-runtime';

class FakeChannel extends EventTarget {
  label = 'c'; ordered = true; maxRetransmits: number | null = null; maxPacketLifeTime: number | null = null;
  readyState = 'connecting'; bufferedAmount = 0; bufferedAmountLowThreshold = 0; binaryType = 'blob';
  sent: Uint8Array[] = []; closed = 0;
  send(data: Uint8Array) { this.sent.push(data); this.bufferedAmount += data.byteLength; }
  close() { this.closed++; this.readyState = 'closed'; }
  open() { this.readyState = 'open'; this.dispatchEvent(new Event('open')); }
  receive(data: Uint8Array) { this.dispatchEvent(new MessageEvent('message', { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) })); }
  drain() { this.bufferedAmount = 0; this.dispatchEvent(new Event('bufferedamountlow')); }
}
class FakePc extends EventTarget {
  static all: FakePc[] = [];
  channels: FakeChannel[] = []; closed = 0;
  constructor() { super(); FakePc.all.push(this); }
  createDataChannel(_l: string, init?: { ordered?: boolean; maxRetransmits?: number }) {
    const c = new FakeChannel(); if (init?.ordered === false) c.ordered = false; if (init?.maxRetransmits !== undefined) c.maxRetransmits = init.maxRetransmits;
    this.channels.push(c); return c;
  }
  incoming(c: FakeChannel) { const e = new Event('datachannel') as Event & { channel: FakeChannel }; e.channel = c; this.dispatchEvent(e); }
  close() { this.closed++; for (const c of this.channels) c.close(); }
}
const native = { RTCPeerConnection: FakePc, RTCSessionDescription: class {}, RTCIceCandidate: class {} } as unknown as RtcConstructors;
const make = (errors: string[] = []) => {
  const changes = { n: 0 };
  const runtime = createBoundedRtcRuntime({ native, now: () => Date.now(), onChange: () => { changes.n++; }, onError: m => errors.push(m) });
  return { runtime, changes, errors };
};
const frame = (n: number) => [...encodeBinaryFrames(new Uint8Array(n).fill(3), 1)];
afterEach(() => { FakePc.all = []; vi.useRealTimers(); });

describe('bounded RTC runtime', () => {
  it('counts only actually-open native channels and reports changes', () => {
    const { runtime, changes } = make();
    const pc = new runtime.wrtc.RTCPeerConnection();
    const ch = pc.createDataChannel('x');
    expect(runtime.getOpenCount()).toBe(0);
    (FakePc.all[0].channels[0]).open();
    expect(runtime.getOpenCount()).toBe(1);
    expect(changes.n).toBeGreaterThan(0);
    ch.close();
    expect(runtime.getOpenCount()).toBe(0);
  });

  it('frames outgoing messages into ≤16 KiB native sends and reassembles inbound frames', () => {
    const { runtime } = make();
    const pc = new runtime.wrtc.RTCPeerConnection();
    const ch = pc.createDataChannel('x');
    const native0 = FakePc.all[0].channels[0]; native0.open();
    const got: ArrayBuffer[] = [];
    ch.onmessage = (e: MessageEvent) => got.push(e.data);
    ch.send(new Uint8Array(40_000).fill(9));
    expect(native0.sent.length).toBe(3);
    expect(native0.sent.every(f => f.byteLength <= 16_384)).toBe(true);
    for (const f of frame(40_000)) native0.receive(f);
    expect(got).toHaveLength(1);
    expect(new Uint8Array(got[0])).toEqual(new Uint8Array(40_000).fill(3));
  });

  it('does not push more than 1 MiB into the native buffer and resumes on drain', () => {
    const { runtime } = make();
    const ch = new runtime.wrtc.RTCPeerConnection().createDataChannel('x');
    const n = FakePc.all[0].channels[0]; n.open();
    ch.send(new Uint8Array(2 * 1024 * 1024));
    expect(n.bufferedAmount).toBeLessThan(1024 * 1024 + 16_384);
    const before = n.sent.length;
    expect(before).toBeLessThan(129);
    n.drain();
    expect(n.sent.length).toBeGreaterThan(before);
  });

  it('never exceeds the 1 MiB native buffer: the next frame must fit', () => {
    const { runtime } = make();
    const ch = new runtime.wrtc.RTCPeerConnection().createDataChannel('x');
    const n = FakePc.all[0].channels[0]; n.open();
    n.bufferedAmount = 1_040_000;
    ch.send(new Uint8Array(40_000));
    expect(n.sent).toHaveLength(0);
    n.bufferedAmount = 1_048_576 - 16_384;
    n.dispatchEvent(new Event('bufferedamountlow'));
    expect(n.sent).toHaveLength(1);
    expect(n.bufferedAmount).toBe(1_048_576);
    n.drain();
    expect(n.sent).toHaveLength(3);
  });

  it('fails the connection (native close + onclose to the owner) when a send overflows the queue, instead of silently dropping', () => {
    const errors: string[] = [];
    const { runtime } = make(errors);
    const ch = new runtime.wrtc.RTCPeerConnection().createDataChannel('x');
    const n = FakePc.all[0].channels[0]; n.open();
    let closes = 0; ch.onclose = () => { closes++; };
    ch.send(new Uint8Array(2 * 1024 * 1024)); ch.send(new Uint8Array(2 * 1024 * 1024));
    expect(() => ch.send(new Uint8Array(1024))).toThrow();
    expect(n.closed).toBe(1);
    expect(closes).toBe(1);
    expect(runtime.getOpenCount()).toBe(0);
    expect(errors).toEqual(['Outbound queue is full.']);
  });

  it('fails the connection for an over-2MiB send', () => {
    const { runtime } = make();
    const ch = new runtime.wrtc.RTCPeerConnection().createDataChannel('x');
    const n = FakePc.all[0].channels[0]; n.open();
    let closes = 0; ch.onclose = () => { closes++; };
    expect(() => ch.send(new Uint8Array(2 * 1024 * 1024 + 1))).toThrow();
    expect(n.closed).toBe(1);
    expect(closes).toBe(1);
  });

  it('allows one data channel per connection and closes excess local and remote channels', () => {
    const errors: string[] = [];
    const { runtime } = make(errors);
    const pc = new runtime.wrtc.RTCPeerConnection();
    const first = pc.createDataChannel('x');
    expect(() => pc.createDataChannel('y')).toThrow();
    const seenChannels: unknown[] = [];
    pc.ondatachannel = (e: any) => seenChannels.push(e.channel);
    const extra = new FakeChannel();
    FakePc.all[0].incoming(extra);
    expect(extra.closed).toBe(1);
    expect(seenChannels).toHaveLength(0);
    expect(errors).toEqual(['Peer opened too many channels.']);
    FakePc.all[0].channels[0].open();
    first.send(new Uint8Array(3));
    expect(FakePc.all[0].channels[0].sent).toHaveLength(1);
  });

  it('releases pending inbound bytes of a silent peer after 10,001 ms and leaves no timers after close', () => {
    vi.useFakeTimers();
    const { runtime } = make();
    const pc = new runtime.wrtc.RTCPeerConnection();
    pc.createDataChannel('x');
    const n = FakePc.all[0].channels[0]; n.open();
    n.receive(frame(40_000)[0]);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10_001);
    expect(vi.getTimerCount()).toBe(0);
    runtime.close();
  });

  it('isolates an invalid frame to the peer that sent it', () => {
    const errors: string[] = [];
    const { runtime } = make(errors);
    const a = new runtime.wrtc.RTCPeerConnection(), b = new runtime.wrtc.RTCPeerConnection();
    const ca = a.createDataChannel('x'), cb = b.createDataChannel('x');
    const [na, nb] = FakePc.all.map(p => p.channels[0]); na.open(); nb.open();
    const gotA: unknown[] = [], gotB: unknown[] = [];
    let closedA = 0; ca.onclose = () => { closedA++; };
    ca.onmessage = (e: MessageEvent) => gotA.push(e.data); cb.onmessage = (e: MessageEvent) => gotB.push(e.data);
    na.receive(new Uint8Array(40));
    expect(errors).toEqual(['Invalid peer frame.']);
    expect(na.closed).toBe(1);
    expect(closedA).toBe(1);
    expect(runtime.getOpenCount()).toBe(1);
    expect(nb.closed).toBe(0);
    for (const f of frame(10)) nb.receive(f);
    expect(gotB).toHaveLength(1);
    expect(gotA).toHaveLength(0);
  });

  it('closes the channel and notifies the owner when the message listener throws, with no timers left', () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const { runtime } = make(errors);
    const ch = new runtime.wrtc.RTCPeerConnection().createDataChannel('x');
    const n = FakePc.all[0].channels[0]; n.open();
    let closes = 0; ch.onclose = () => { closes++; };
    ch.onmessage = () => { throw new Error('secret-listener-detail'); };
    expect(() => frame(5).forEach(f => n.receive(f))).not.toThrow();
    expect(errors).toEqual(['Peer message handler failed.']);
    expect(n.closed).toBe(1);
    expect(closes).toBe(1);
    expect(runtime.getOpenCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes unordered or lossy channels', () => {
    const errors: string[] = [];
    const { runtime } = make(errors);
    new runtime.wrtc.RTCPeerConnection().createDataChannel('x', { ordered: false });
    expect(FakePc.all[0].channels[0].closed).toBe(1);
    expect(errors).toEqual(['Peer channel is not ordered and reliable.']);
  });

  it('wraps channels received through ondatachannel', () => {
    const { runtime } = make();
    const pc = new runtime.wrtc.RTCPeerConnection();
    let received: any;
    pc.ondatachannel = (e: any) => { received = e.channel; };
    const incoming = new FakeChannel();
    FakePc.all[0].incoming(incoming);
    incoming.open();
    expect(runtime.getOpenCount()).toBe(1);
    received.send(new Uint8Array(3));
    expect(incoming.sent[0].byteLength).toBe(19);
  });

  it('refuses a 32nd concurrent native connection', () => {
    const { runtime } = make();
    for (let i = 0; i < 31; i++) new runtime.wrtc.RTCPeerConnection();
    expect(() => new runtime.wrtc.RTCPeerConnection()).toThrow();
  });

  it('closes every native object once, leaves no timers, and tolerates repeated close', () => {
    vi.useFakeTimers();
    const { runtime } = make();
    const pcs = [0, 1, 2].map(() => new runtime.wrtc.RTCPeerConnection());
    pcs.forEach(p => p.createDataChannel('x'));
    FakePc.all.forEach(p => p.channels[0].open());
    expect(runtime.getOpenCount()).toBe(3);
    runtime.close(); runtime.close();
    expect(runtime.getOpenCount()).toBe(0);
    expect(FakePc.all.map(p => p.closed)).toEqual([1, 1, 1]);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => new runtime.wrtc.RTCPeerConnection()).toThrow();
  });

  it('does not report change callbacks after close', () => {
    const { runtime, changes } = make();
    new runtime.wrtc.RTCPeerConnection().createDataChannel('x');
    runtime.close();
    const n = changes.n;
    FakePc.all[0].channels[0].open();
    expect(changes.n).toBe(n);
  });
});
