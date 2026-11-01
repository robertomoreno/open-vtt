import { createBinaryAssembler, createInboundBudget, encodeBinaryFrames } from './binary-framing';
import { MESSAGE_BYTES, NATIVE_BUFFERED_BYTES, NATIVE_BUFFER_LOW_BYTES, NATIVE_REMOTE_CONNECTIONS, OUTBOUND_QUEUE_CONNECTION_BYTES, OUTBOUND_QUEUE_TOTAL_BYTES } from './limits';

export type RtcConstructors = Pick<typeof globalThis, 'RTCPeerConnection' | 'RTCSessionDescription' | 'RTCIceCandidate'>;
type Options = { native?: RtcConstructors; now: () => number; onChange: () => void; onError: (message: string) => void };
type Handler = ((event: any) => void) | null;
type Frames = { iterator: Iterator<Uint8Array>; bytes: number };

export function createBoundedRtcRuntime(options: Options) {
  const native: RtcConstructors = options.native ?? {
    RTCPeerConnection: globalThis.RTCPeerConnection,
    RTCSessionDescription: globalThis.RTCSessionDescription,
    RTCIceCandidate: globalThis.RTCIceCandidate,
  };
  const NativePc = native.RTCPeerConnection as unknown as new (config?: RTCConfiguration) => any;
  const inbound = createInboundBudget();
  const connections = new Set<any>();
  const channels = new Set<{ shutdown(): void }>();
  let closed = false;
  let openCount = 0;
  let outboundTotal = 0;

  const changed = () => { if (!closed) options.onChange(); };
  const report = (message: string) => { if (!closed) options.onError(message); };

  function wrapChannel(channel: any) {
    const abort = new AbortController();
    const assembler = createBinaryAssembler(options.now, inbound);
    const queue: Frames[] = [];
    let queued = 0;
    let transferId = 0;
    let opened = false;
    let done = false;
    let threshold = 0;
    const handlers: Record<'onopen' | 'onclose' | 'onerror' | 'onmessage' | 'onbufferedamountlow', Handler> = { onopen: null, onclose: null, onerror: null, onmessage: null, onbufferedamountlow: null };

    const call = (name: keyof typeof handlers, event: unknown) => {
      try { handlers[name]?.(event); } catch { report('Peer message handler failed.'); }
    };
    const markClosed = () => {
      if (opened) { opened = false; openCount--; }
      if (!done) {
        done = true;
        abort.abort();
        assembler.clear();
        outboundTotal -= queued;
        queued = 0;
        queue.length = 0;
        channels.delete(api);
      }
      changed();
    };
    const fail = (message: string) => {
      report(message);
      const wasDone = done;
      markClosed();
      if (!wasDone) { try { channel.close(); } catch { /* already closed */ } }
    };
    const pump = () => {
      while (!done && queue.length > 0 && channel.readyState === 'open' && channel.bufferedAmount < NATIVE_BUFFERED_BYTES) {
        const head = queue[0];
        const next = head.iterator.next();
        if (next.done) { queue.shift(); queued -= head.bytes; outboundTotal -= head.bytes; continue; }
        try { channel.send(next.value); } catch { fail('Peer send failed.'); return; }
      }
    };
    const total = () => channel.bufferedAmount + queued;

    const api: any = {
      shutdown() { const wasDone = done; markClosed(); if (!wasDone) { try { channel.close(); } catch { /* already closed */ } } },
      get label() { return channel.label; },
      get readyState() { return channel.readyState; },
      get bufferedAmount() { return total(); },
      get bufferedAmountLowThreshold() { return threshold; },
      set bufferedAmountLowThreshold(value: number) { threshold = value; },
      get binaryType() { return 'arraybuffer'; },
      set binaryType(_value: string) { /* native channel is always arraybuffer */ },
      get ordered() { return channel.ordered; },
      send(data: unknown) {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : undefined;
        if (!bytes) throw new Error('Only binary data can be sent.');
        if (bytes.byteLength > MESSAGE_BYTES) throw new Error('Message is too large.');
        if (done) throw new Error('Channel is closed.');
        if (queued + bytes.byteLength > OUTBOUND_QUEUE_CONNECTION_BYTES || outboundTotal + bytes.byteLength > OUTBOUND_QUEUE_TOTAL_BYTES) throw new Error('Outbound queue is full.');
        queued += bytes.byteLength;
        outboundTotal += bytes.byteLength;
        queue.push({ iterator: encodeBinaryFrames(bytes, transferId++ >>> 0)[Symbol.iterator](), bytes: bytes.byteLength });
        pump();
      },
      close() { api.shutdown(); },
    };
    for (const name of Object.keys(handlers) as (keyof typeof handlers)[]) {
      Object.defineProperty(api, name, { get: () => handlers[name], set: (fn: Handler) => { handlers[name] = fn; }, enumerable: true });
    }

    const listen = (type: string, fn: (event: any) => void) => channel.addEventListener(type, fn, { signal: abort.signal });
    channels.add(api);
    if (channel.ordered !== true || (channel.maxRetransmits ?? null) !== null || (channel.maxPacketLifeTime ?? null) !== null) {
      fail('Peer channel is not ordered and reliable.');
      return api;
    }
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = NATIVE_BUFFER_LOW_BYTES;
    listen('open', event => { if (done || opened) return; opened = true; openCount++; changed(); call('onopen', event); pump(); });
    listen('close', event => { const wasDone = done; markClosed(); if (!wasDone) call('onclose', event); });
    listen('error', event => call('onerror', event));
    listen('bufferedamountlow', () => {
      pump();
      if (!done && queue.length === 0 && total() <= threshold) call('onbufferedamountlow', new Event('bufferedamountlow'));
    });
    listen('message', event => {
      if (done) return;
      const data = event.data;
      let message: Uint8Array | undefined;
      try {
        if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) throw new Error('Invalid frame data.');
        message = assembler.accept(data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      } catch {
        fail('Invalid peer frame.');
        return;
      }
      if (message) call('onmessage', new MessageEvent('message', { data: message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) }));
    });
    if (channel.readyState === 'open') { opened = true; openCount++; changed(); }
    return api;
  }

  class GuardedPeerConnection extends NativePc {
    #handler: Handler = null;
    #done = false;
    constructor(config?: RTCConfiguration) {
      if (closed) throw new Error('RTC runtime is closed.');
      if (connections.size >= NATIVE_REMOTE_CONNECTIONS) throw new Error('Too many peer connections.');
      super(config);
      connections.add(this);
      this.addEventListener('datachannel', (event: any) => {
        const wrapped = wrapChannel(event.channel);
        try { this.#handler?.({ channel: wrapped }); } catch { report('Peer message handler failed.'); }
      });
    }
    get ondatachannel(): Handler { return this.#handler; }
    set ondatachannel(fn: Handler) { this.#handler = fn; }
    createDataChannel(label: string, init?: RTCDataChannelInit) {
      return wrapChannel(super.createDataChannel(label, init));
    }
    close() {
      if (this.#done) return;
      this.#done = true;
      connections.delete(this);
      super.close();
    }
  }

  return {
    wrtc: { RTCPeerConnection: GuardedPeerConnection, RTCSessionDescription: native.RTCSessionDescription, RTCIceCandidate: native.RTCIceCandidate } as unknown as RtcConstructors,
    getOpenCount: () => openCount,
    close() {
      if (closed) return;
      closed = true;
      for (const channel of [...channels]) channel.shutdown();
      for (const connection of [...connections]) connection.close();
      connections.clear();
      openCount = 0;
    },
  };
}
