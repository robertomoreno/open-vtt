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
const native = { RTCPeerConnection: FakePc } as unknown as RtcConstructors;
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
    const pc = new runtime.rtcPolyfill();
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
    const pc = new runtime.rtcPolyfill();
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
    const ch = new runtime.rtcPolyfill().createDataChannel('x');
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
    const ch = new runtime.rtcPolyfill().createDataChannel('x');
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
    const ch = new runtime.rtcPolyfill().createDataChannel('x');
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
    const ch = new runtime.rtcPolyfill().createDataChannel('x');
    const n = FakePc.all[0].channels[0]; n.open();
    let closes = 0; ch.onclose = () => { closes++; };
    expect(() => ch.send(new Uint8Array(2 * 1024 * 1024 + 1))).toThrow();
    expect(n.closed).toBe(1);
    expect(closes).toBe(1);
  });

  it('treats a second channel as a misbehaving peer: closes the whole connection and notifies the owner', () => {
    const errors: string[] = [];
    const { runtime } = make(errors);
    const pc = new runtime.rtcPolyfill();
    const first = pc.createDataChannel('x');
    let closes = 0; first.onclose = () => { closes++; };
    let iceNotices = 0; (pc as any).oniceconnectionstatechange = () => { iceNotices++; };
    expect(() => pc.createDataChannel('y')).toThrow();
    const seenChannels: unknown[] = [];
    pc.ondatachannel = (e: any) => seenChannels.push(e.channel);
    const extra = new FakeChannel();
    FakePc.all[0].incoming(extra);
    expect(extra.closed).toBe(1);
    expect(seenChannels).toHaveLength(0);
    expect(FakePc.all[0].closed).toBe(1);
    expect(FakePc.all[0].channels[0].closed).toBeGreaterThanOrEqual(1);
    expect(iceNotices).toBe(1);
    expect(errors).toEqual(['Peer opened too many channels.']);
    expect(runtime.getOpenCount()).toBe(0);
  });

  it('fails the owning peer and releases bytes when an inbound transfer expires while the peer is silent', () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const { runtime } = make(errors);
    const ch = new runtime.rtcPolyfill().createDataChannel('x');
    let closes = 0; ch.onclose = () => { closes++; };
    const n = FakePc.all[0].channels[0]; n.open();
    n.receive(frame(40_000)[0]);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(closes).toBe(0);
    vi.advanceTimersByTime(1);
    expect(closes).toBe(1);
    expect(n.closed).toBe(1);
    expect(errors).toEqual(['Peer transfer expired.']);
    expect(vi.getTimerCount()).toBe(0);
    expect(runtime.getOpenCount()).toBe(0);
  });

  it('replays the close to a handler installed after an early guard failure (unreliable local channel)', async () => {
    const errors: string[] = [];
    const { runtime } = make(errors);
    const pc = new runtime.rtcPolyfill();
    const ch = pc.createDataChannel('x', { ordered: false });
    expect(FakePc.all[0].channels[0].closed).toBe(1);
    let closes = 0;
    ch.onclose = () => { closes++; pc.close(); };
    expect(closes).toBe(0);
    await Promise.resolve();
    expect(closes).toBe(1);
    expect(FakePc.all[0].closed).toBe(1);
    await Promise.resolve();
    expect(closes).toBe(1);
  });

  it('closes the owning connection and notifies it when the incoming-channel handler throws', () => {
    const errors: string[] = [];
    const { runtime } = make(errors);
    const pc = new runtime.rtcPolyfill();
    let iceNotices = 0; (pc as any).oniceconnectionstatechange = () => { iceNotices++; };
    pc.ondatachannel = () => { throw new Error('secret'); };
    const incoming = new FakeChannel();
    FakePc.all[0].incoming(incoming);
    expect(incoming.closed).toBe(1);
    expect(FakePc.all[0].closed).toBe(1);
    expect(iceNotices).toBe(1);
    expect(errors).toEqual(['Peer message handler failed.']);
  });

  it('isolates an invalid frame to the peer that sent it', () => {
    const errors: string[] = [];
    const { runtime } = make(errors);
    const a = new runtime.rtcPolyfill(), b = new runtime.rtcPolyfill();
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
    const ch = new runtime.rtcPolyfill().createDataChannel('x');
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
    new runtime.rtcPolyfill().createDataChannel('x', { ordered: false });
    expect(FakePc.all[0].channels[0].closed).toBe(1);
    expect(errors).toEqual(['Peer channel is not ordered and reliable.']);
  });

  it('wraps channels received through ondatachannel', () => {
    const { runtime } = make();
    const pc = new runtime.rtcPolyfill();
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
    for (let i = 0; i < 31; i++) new runtime.rtcPolyfill();
    expect(() => new runtime.rtcPolyfill()).toThrow();
  });

  it('closes every native object once, leaves no timers, and tolerates repeated close', () => {
    vi.useFakeTimers();
    const { runtime } = make();
    const pcs = [0, 1, 2].map(() => new runtime.rtcPolyfill());
    pcs.forEach(p => p.createDataChannel('x'));
    FakePc.all.forEach(p => p.channels[0].open());
    expect(runtime.getOpenCount()).toBe(3);
    runtime.close(); runtime.close();
    expect(runtime.getOpenCount()).toBe(0);
    expect(FakePc.all.map(p => p.closed)).toEqual([1, 1, 1]);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => new runtime.rtcPolyfill()).toThrow();
  });

  it('does not report change callbacks after close', () => {
    const { runtime, changes } = make();
    new runtime.rtcPolyfill().createDataChannel('x');
    runtime.close();
    const n = changes.n;
    FakePc.all[0].channels[0].open();
    expect(changes.n).toBe(n);
  });
});

describe('open announcement', () => {
  it('still delivers the open event to the owner when the incoming channel was already open at hand-off', () => {
    const { runtime } = make();
    const pc = new runtime.rtcPolyfill();
    let received: any;
    pc.ondatachannel = (e: any) => { received = e.channel; };
    const incoming = new FakeChannel();
    incoming.readyState = 'open';
    FakePc.all[0].incoming(incoming);
    expect(runtime.getOpenCount()).toBe(1);
    let opens = 0;
    received.onopen = () => { opens++; };
    incoming.dispatchEvent(new Event('open'));
    incoming.dispatchEvent(new Event('open'));
    expect(opens).toBe(1);
    expect(runtime.getOpenCount()).toBe(1);
  });
});

describe('channel listener API', () => {
  const open = () => {
    const errors: string[] = [];
    const { runtime } = make(errors);
    const ch: any = new runtime.rtcPolyfill().createDataChannel('x');
    const n = FakePc.all[0].channels[0]; n.open();
    return { ch, n, errors, runtime };
  };

  it('delivers the reconstructed MessageEvent, with its data, to addEventListener consumers', () => {
    const { ch, n } = open();
    const events: any[] = [];
    ch.addEventListener('message', (e: any) => events.push(e));
    for (const f of frame(10)) n.receive(f);
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(MessageEvent);
    expect(new Uint8Array(events[0].data)).toEqual(new Uint8Array(10).fill(3));
  });

  it('delivers close and bufferedamountlow events to listeners and honours removeEventListener and once', () => {
    const { ch, n } = open();
    const seen: string[] = [];
    const low = () => seen.push('low');
    ch.addEventListener('bufferedamountlow', low);
    ch.addEventListener('close', () => seen.push('close'), { once: true });
    n.drain();
    ch.removeEventListener('bufferedamountlow', low);
    n.drain();
    n.close(); n.dispatchEvent(new Event('close'));
    expect(seen).toEqual(['low', 'close']);
  });

  it('contains a throwing listener without throwing, without crashing the process, and fails only that peer', async () => {
    const uncaught = vi.fn();
    process.on('uncaughtException', uncaught);
    try {
      const { ch, n, errors } = open();
      const later = vi.fn();
      ch.addEventListener('message', () => { throw new Error('secret-listener-detail'); });
      ch.addEventListener('message', later);
      expect(() => frame(5).forEach(f => n.receive(f))).not.toThrow();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(uncaught).not.toHaveBeenCalled();
      expect(later).toHaveBeenCalledTimes(1);
      expect(errors).toEqual(['Peer message handler failed.']);
      expect(n.closed).toBe(1);
    } finally { process.off('uncaughtException', uncaught); }
  });

  it('still notifies the remaining close listeners when one close listener throws', async () => {
    const uncaught = vi.fn();
    process.on('uncaughtException', uncaught);
    try {
      const { ch, n } = open();
      const second = vi.fn();
      ch.addEventListener('close', () => { throw new Error('boom'); });
      ch.addEventListener('close', second);
      n.dispatchEvent(new Event('close'));
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(second).toHaveBeenCalledTimes(1);
      expect(uncaught).not.toHaveBeenCalled();
    } finally { process.off('uncaughtException', uncaught); }
  });
});

describe('native EventTarget semantics on the wrapper', () => {
  const open = () => {
    const { runtime } = make();
    const ch: any = new runtime.rtcPolyfill().createDataChannel('x');
    const n = FakePc.all[0].channels[0]; n.open();
    return { ch, n };
  };

  it('honours an already-aborted and a later-aborted AbortSignal registration', () => {
    const { ch, n } = open();
    const late = new AbortController(), early = new AbortController(); early.abort();
    const lateSeen = vi.fn(), earlySeen = vi.fn(), plain = vi.fn();
    ch.addEventListener('message', earlySeen, { signal: early.signal });
    ch.addEventListener('message', lateSeen, { signal: late.signal });
    ch.addEventListener('message', plain);
    for (const f of frame(4)) n.receive(f);
    late.abort();
    for (const f of frame(4)) n.receive(f);
    expect(earlySeen).not.toHaveBeenCalled();
    expect(lateSeen).toHaveBeenCalledTimes(1);
    expect(plain).toHaveBeenCalledTimes(2);
  });

  it('uses the wrapper, not the native channel, as target and currentTarget for every forwarded event', () => {
    const { ch, n } = open();
    const seen: Array<{ type: string; target: unknown; current: unknown }> = [];
    for (const type of ['message', 'bufferedamountlow', 'close']) ch.addEventListener(type, (e: Event) => seen.push({ type, target: e.target, current: e.currentTarget }));
    for (const f of frame(4)) n.receive(f);
    n.drain();
    n.dispatchEvent(new Event('close'));
    expect(seen.map(entry => entry.type)).toEqual(['message', 'bufferedamountlow', 'close']);
    for (const entry of seen) { expect([entry.type, entry.target === ch]).toEqual([entry.type, true]); expect([entry.type, entry.current === ch]).toEqual([entry.type, true]); expect(entry.target === n).toBe(false); }
  });

  it('gives an on* attribute handler the wrapper as target and currentTarget', () => {
    const { ch, n } = open();
    const seen: unknown[][] = [];
    ch.onmessage = (e: Event) => seen.push([e.target, e.currentTarget]);
    for (const f of frame(4)) n.receive(f);
    expect(seen).toHaveLength(1);
    expect(seen[0].every(t => t === ch)).toBe(true);
  });

  it('deduplicates the same listener, supports capture-insensitive removal, and handleEvent objects', () => {
    const { ch, n } = open();
    const fn = vi.fn(), obj = { handleEvent: vi.fn() };
    ch.addEventListener('message', fn); ch.addEventListener('message', fn);
    ch.addEventListener('message', obj);
    for (const f of frame(4)) n.receive(f);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(obj.handleEvent).toHaveBeenCalledTimes(1);
    ch.removeEventListener('message', fn);
    for (const f of frame(4)) n.receive(f);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('close replay with no live listener', () => {
  // the guard failure happens only after the stale registration, which is the edge case
  const failed = () => {
    const { runtime } = make();
    const ch: any = new runtime.rtcPolyfill().createDataChannel('x');
    const native = FakePc.all[0].channels[0]; native.open();
    return { ch, native, fail: () => native.receive(new Uint8Array(40)) };
  };
  const stale: Array<[string, (ch: any, fn: () => void) => void]> = [
    ['an already-aborted signal', (ch, fn) => { const c = new AbortController(); c.abort(); ch.addEventListener('close', fn, { signal: c.signal }); }],
    ['a removed listener', (ch, fn) => { ch.addEventListener('close', fn); ch.removeEventListener('close', fn); }],
    ['a listener whose signal aborted later', (ch, fn) => { const c = new AbortController(); ch.addEventListener('close', fn, { signal: c.signal }); c.abort(); }],
  ];
  for (const [label, register] of stale) {
    it(`still replays the close to a later onclose after ${label}`, async () => {
      const { ch, fail } = failed();
      const stale = vi.fn(), later = vi.fn();
      register(ch, stale);
      fail();
      await Promise.resolve();
      ch.onclose = later;
      await Promise.resolve(); await Promise.resolve();
      expect(stale).not.toHaveBeenCalled();
      expect(later).toHaveBeenCalledTimes(1);
      expect((later.mock.calls[0] as any)[0]).toBeInstanceOf(Event);
    });
    it(`still replays the close once to a later addEventListener after ${label}`, async () => {
      const { ch, fail } = failed();
      const stale = vi.fn(), later = vi.fn();
      register(ch, stale);
      fail();
      ch.addEventListener('close', later);
      await Promise.resolve(); await Promise.resolve();
      expect(stale).not.toHaveBeenCalled();
      expect(later).toHaveBeenCalledTimes(1);
      expect((later.mock.calls[0] as any)[0].target).toBe(ch);
    });
  }

  it('delivers the close to a live once listener exactly once and does not replay it', async () => {
    const { ch, fail } = failed();
    const once = vi.fn();
    ch.addEventListener('close', once, { once: true });
    fail();
    ch.onclose = vi.fn();
    await Promise.resolve(); await Promise.resolve();
    expect(once).toHaveBeenCalledTimes(1);
  });

  it('keeps a capture listener live when removed with the wrong capture option', async () => {
    const { ch, fail } = failed();
    const listener = vi.fn(), later = vi.fn();
    ch.addEventListener('close', listener, { capture: true });
    ch.removeEventListener('close', listener, { capture: false });
    fail();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].target).toBe(ch);
    ch.onclose = later;
    await Promise.resolve();
    expect(later).not.toHaveBeenCalled();
  });

  it('delivers close to both capture registrations of the same callback', () => {
    const { ch, fail } = failed();
    const listener = vi.fn();
    ch.addEventListener('close', listener, { capture: true });
    ch.addEventListener('close', listener, { capture: false });
    fail();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  for (const removedCapture of [true, false]) {
    it(`delivers close to the other capture registration after removing capture=${removedCapture}`, async () => {
      const { ch, fail } = failed();
      const listener = vi.fn(), later = vi.fn();
      ch.addEventListener('close', listener, { capture: true });
      ch.addEventListener('close', listener, { capture: false });
      ch.removeEventListener('close', listener, { capture: removedCapture });
      fail();
      expect(listener).toHaveBeenCalledTimes(1);
      ch.onclose = later;
      await Promise.resolve();
      expect(later).not.toHaveBeenCalled();
    });

    it(`keeps the other capture registration live after aborting capture=${removedCapture}`, async () => {
      const { ch, fail } = failed();
      const controller = new AbortController();
      const listener = vi.fn(), later = vi.fn();
      ch.addEventListener('close', listener, { capture: removedCapture, signal: controller.signal });
      ch.addEventListener('close', listener, { capture: !removedCapture });
      controller.abort();
      fail();
      expect(listener).toHaveBeenCalledTimes(1);
      ch.onclose = later;
      await Promise.resolve();
      expect(later).not.toHaveBeenCalled();
    });
  }

  it('ignores a duplicate registration signal when the original listener remains live', async () => {
    const { ch, fail } = failed();
    const controller = new AbortController();
    const listener = vi.fn(), later = vi.fn();
    ch.addEventListener('close', listener, { capture: true });
    ch.addEventListener('close', listener, { capture: true, signal: controller.signal });
    controller.abort();
    fail();
    expect(listener).toHaveBeenCalledTimes(1);
    ch.onclose = later;
    await Promise.resolve();
    expect(later).not.toHaveBeenCalled();
  });

  it('does not let an old aborted signal remove a newly registered listener', () => {
    const { ch, fail } = failed();
    const controller = new AbortController();
    const listener = vi.fn();
    ch.addEventListener('close', listener, { capture: true, signal: controller.signal });
    ch.removeEventListener('close', listener, true);
    ch.addEventListener('close', listener, true);
    controller.abort();
    fail();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('honours once independently for two capture registrations', async () => {
    const { ch, fail } = failed();
    const listener = vi.fn(), later = vi.fn();
    ch.addEventListener('close', listener, { capture: true, once: true });
    ch.addEventListener('close', listener, { capture: false });
    fail();
    expect(listener).toHaveBeenCalledTimes(2);
    ch.onclose = later;
    await Promise.resolve();
    expect(later).not.toHaveBeenCalled();
    ch.dispatchEvent(new Event('close'));
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
