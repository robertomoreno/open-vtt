import { createBinaryAssembler, createInboundBudget, encodeBinaryFrames } from './binary-framing';
import { MESSAGE_BYTES, NATIVE_BUFFERED_BYTES, NATIVE_BUFFER_LOW_BYTES, NATIVE_REMOTE_CONNECTIONS, OUTBOUND_QUEUE_CONNECTION_BYTES, OUTBOUND_QUEUE_TOTAL_BYTES } from './limits';

export type RtcConstructors = Pick<typeof globalThis, 'RTCPeerConnection'>;
type Options = { native?: RtcConstructors; now: () => number; onChange: () => void; onError: (message: string) => void };
type Handler = ((event: any) => void) | null;
type Frames = { iterator: Iterator<Uint8Array>; bytes: number; held?: Uint8Array };

export function createBoundedRtcRuntime(options: Options) {
  const native: RtcConstructors = options.native ?? { RTCPeerConnection: globalThis.RTCPeerConnection };
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
    let pendingClose = false;
    const abort = new AbortController();
    const assembler = createBinaryAssembler(options.now, inbound, () => fail('Peer transfer expired.'));
    const queue: Frames[] = [];
    let queued = 0;
    let transferId = 0;
    let opened = false;
    let done = false;
    let threshold = 0;
    const handlers: Record<'onopen' | 'onclose' | 'onerror' | 'onmessage' | 'onbufferedamountlow', Handler> = { onopen: null, onclose: null, onerror: null, onmessage: null, onbufferedamountlow: null };

    // Own listener registry: EventTarget reports listener exceptions asynchronously and cannot be contained here.
    const listeners = new Map<string, Array<{ fn: EventListenerOrEventListenerObject; once: boolean }>>();
    const call = (name: keyof typeof handlers, event: any): boolean => {
      let ok = true;
      try { handlers[name]?.(event); } catch { ok = false; }
      const type = name.slice(2);
      for (const entry of [...(listeners.get(type) ?? [])]) {
        if (entry.once) listeners.set(type, (listeners.get(type) ?? []).filter(other => other !== entry));
        try { typeof entry.fn === 'function' ? entry.fn.call(api, event) : entry.fn.handleEvent(event); } catch { ok = false; }
      }
      return ok;
    };
    const notifyClose = (event: unknown) => {
      if (handlers.onclose || (listeners.get('close')?.length ?? 0) > 0) call('onclose', event);
      else pendingClose = true;
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
      try { channel.close(); } catch { /* already closed */ }
      if (!wasDone) notifyClose(new Event('close'));
    };
    const pump = () => {
      while (!done && queue.length > 0 && channel.readyState === 'open') {
        const head = queue[0];
        if (!head.held) {
          const next = head.iterator.next();
          if (next.done) { queue.shift(); queued -= head.bytes; outboundTotal -= head.bytes; continue; }
          head.held = next.value;
        }
        if (channel.bufferedAmount + head.held.byteLength > NATIVE_BUFFERED_BYTES) return;
        const frame = head.held;
        head.held = undefined;
        try { channel.send(frame); } catch { fail('Peer send failed.'); return; }
      }
    };
    const total = () => channel.bufferedAmount + queued;

    const api: any = {
      shutdown() { const was = done; markClosed(); if (!was) { try { channel.close(); } catch { /* already closed */ } } },
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
        if (done) throw new Error('Channel is closed.');
        if (bytes.byteLength > MESSAGE_BYTES) { fail('Outbound message is too large.'); throw new Error('Message is too large.'); }
        if (queued + bytes.byteLength > OUTBOUND_QUEUE_CONNECTION_BYTES || outboundTotal + bytes.byteLength > OUTBOUND_QUEUE_TOTAL_BYTES) { fail('Outbound queue is full.'); throw new Error('Outbound queue is full.'); }
        queued += bytes.byteLength;
        outboundTotal += bytes.byteLength;
        queue.push({ iterator: encodeBinaryFrames(bytes, transferId++ >>> 0)[Symbol.iterator](), bytes: bytes.byteLength });
        pump();
      },
      close() { api.shutdown(); },
      addEventListener(type: string, fn: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) {
        const list = listeners.get(type) ?? [];
        if (!list.some(entry => entry.fn === fn)) list.push({ fn, once: typeof options === 'object' && options.once === true });
        listeners.set(type, list);
      },
      removeEventListener(type: string, fn: EventListenerOrEventListenerObject) {
        listeners.set(type, (listeners.get(type) ?? []).filter(entry => entry.fn !== fn));
      },
    };
    for (const name of Object.keys(handlers) as (keyof typeof handlers)[]) {
      Object.defineProperty(api, name, {
        get: () => handlers[name],
        set: (fn: Handler) => {
          handlers[name] = fn;
          if (name === 'onclose' && fn && pendingClose) { pendingClose = false; queueMicrotask(() => call('onclose', new Event('close'))); }
        },
        enumerable: true,
      });
    }

    const listen = (type: string, fn: (event: any) => void) => channel.addEventListener(type, fn, { signal: abort.signal });
    channels.add(api);
    if (channel.ordered !== true || (channel.maxRetransmits ?? null) !== null || (channel.maxPacketLifeTime ?? null) !== null) {
      fail('Peer channel is not ordered and reliable.');
      return api;
    }
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = NATIVE_BUFFER_LOW_BYTES;
    let announced = false;
    listen('open', event => {
      if (done || announced) return;
      announced = true;
      if (!opened) { opened = true; openCount++; changed(); }
      if (!call('onopen', event)) { fail('Peer handler failed.'); return; }
      pump();
    });
    listen('close', event => { const wasDone = done; markClosed(); if (!wasDone) notifyClose(event); });
    listen('error', event => { if (!call('onerror', event)) fail('Peer handler failed.'); });
    listen('bufferedamountlow', () => {
      pump();
      if (!done && queue.length === 0 && total() <= threshold && !call('onbufferedamountlow', new Event('bufferedamountlow'))) fail('Peer handler failed.');
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
      if (message && !call('onmessage', new MessageEvent('message', { data: message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) }))) fail('Peer message handler failed.');
    });
    if (channel.readyState === 'open') { opened = true; openCount++; changed(); }
    return api;
  }

  class GuardedPeerConnection extends NativePc {
    #handler: Handler = null;
    #done = false;
    #channels = 0;
    #wrapped: { shutdown(): void }[] = [];
    #aborted = false;
    constructor(config?: RTCConfiguration) {
      if (closed) throw new Error('RTC runtime is closed.');
      if (connections.size >= NATIVE_REMOTE_CONNECTIONS) throw new Error('Too many peer connections.');
      super(config);
      connections.add(this);
      this.addEventListener('datachannel', (event: any) => {
        if (this.#channels >= 1) {
          report('Peer opened too many channels.');
          try { event.channel.close(); } catch { /* already closed */ }
          this.abort();
          return;
        }
        this.#channels++;
        const wrapped = wrapChannel(event.channel);
        this.#wrapped.push(wrapped);
        try { this.#handler?.({ channel: wrapped }); } catch { report('Peer message handler failed.'); wrapped.shutdown(); this.abort(); }
      });
    }
    get ondatachannel(): Handler { return this.#handler; }
    set ondatachannel(fn: Handler) { this.#handler = fn; }
    createDataChannel(label: string, init?: RTCDataChannelInit) {
      if (this.#channels >= 1) throw new Error('Only one data channel is allowed per connection.');
      this.#channels++;
      const wrapped = wrapChannel(super.createDataChannel(label, init));
      this.#wrapped.push(wrapped);
      return wrapped;
    }
    // Close this connection and tell its owner (Trystero reacts to iceConnectionState 'closed').
    abort() {
      if (this.#aborted) return;
      this.#aborted = true;
      this.close();
      try { (this as any).oniceconnectionstatechange?.(new Event('iceconnectionstatechange')); } catch { /* owner already gone */ }
    }
    close() {
      if (this.#done) return;
      this.#done = true;
      connections.delete(this);
      for (const wrapped of this.#wrapped) wrapped.shutdown();
      super.close();
    }
  }

  return {
    rtcPolyfill: GuardedPeerConnection as unknown as RtcConstructors['RTCPeerConnection'],
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
