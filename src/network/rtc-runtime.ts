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
    type CloseRegistration = { wrapper: EventListener; signal?: AbortSignal; onAbort?: () => void };
    const liveClose = new Map<EventListenerOrEventListenerObject, Map<boolean, CloseRegistration>>();
    const abort = new AbortController();
    const assembler = createBinaryAssembler(options.now, inbound, () => fail('Peer transfer expired.'));
    const queue: Frames[] = [];
    let queued = 0;
    let transferId = 0;
    let opened = false;
    let done = false;
    let threshold = 0;
    const handlers: Record<'onopen' | 'onclose' | 'onerror' | 'onmessage' | 'onbufferedamountlow', Handler> = { onopen: null, onclose: null, onerror: null, onmessage: null, onbufferedamountlow: null };

    // The wrapper is a real EventTarget so signal/once/dedupe and target/currentTarget keep native semantics; each registered
    // listener is wrapped so an exception is contained (EventTarget would otherwise report it asynchronously and uncatchably).
    const wrapped = new WeakMap<object, EventListener>();
    const wrappers = new WeakSet<object>();
    let listenerFailed = false;
    const containing = (fn: EventListenerOrEventListenerObject): EventListener => {
      if (wrappers.has(fn)) return fn as EventListener; // the platform calls removeEventListener with our wrapper on AbortSignal abort
      let wrapper = wrapped.get(fn);
      if (!wrapper) {
        wrapper = function (this: unknown, event: Event) {
          try { typeof fn === 'function' ? fn.call(this, event) : fn.handleEvent(event); } catch { listenerFailed = true; }
        };
        wrapped.set(fn, wrapper);
        wrappers.add(wrapper);
      }
      return wrapper;
    };
    const retarget = (event: any): Event => {
      if (event.target === null || event.target === undefined) return event;
      const copy: any = new Event(event.type);
      if ('error' in event) copy.error = event.error;
      return copy;
    };
    const call = (name: keyof typeof handlers, original: any): boolean => {
      const event = retarget(original);
      let ok = true;
      listenerFailed = false;
      try { EventTarget.prototype.dispatchEvent.call(api, event); } catch { ok = false; }
      return ok && !listenerFailed;
    };
    const removeClose = (fn: EventListenerOrEventListenerObject, capture: boolean, registration: CloseRegistration) => {
      const registrations = liveClose.get(fn);
      if (registrations?.get(capture) !== registration) return;
      registrations.delete(capture);
      if (registrations.size === 0) liveClose.delete(fn);
      registration.signal?.removeEventListener('abort', registration.onAbort!);
      EventTarget.prototype.removeEventListener.call(api, 'close', registration.wrapper, { capture });
    };
    // signal.aborted is authoritative: an earlier abort listener may have stopped our cleanup listener from running
    const pruneAborted = () => {
      for (const [fn, registrations] of [...liveClose]) {
        for (const [capture, registration] of [...registrations]) if (registration.signal?.aborted) removeClose(fn, capture, registration);
      }
    };
    const hasLiveClose = () => { pruneAborted(); return handlers.onclose || liveClose.size > 0; };
    // a close recorded while nobody was listening is delivered once to the first live handler or listener that appears
    const replayClose = () => {
      if (!pendingClose) return;
      pendingClose = false;
      queueMicrotask(() => {
        if (hasLiveClose()) call('onclose', new Event('close'));
        else pendingClose = true;
      });
    };
    const notifyClose = (event: unknown) => {
      if (hasLiveClose()) call('onclose', event);
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

    const members: any = {
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
      addEventListener(type: string, fn: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
        if (!fn) return;
        if (type === 'close') {
          const capture = typeof options === 'boolean' ? options : options?.capture === true;
          const signal = typeof options === 'object' && options !== null ? options.signal : undefined;
          pruneAborted();
          if (signal?.aborted || liveClose.get(fn)?.has(capture)) return;
          const once = typeof options === 'object' && options !== null && options.once === true;
          const registration: CloseRegistration = {
            signal,
            wrapper: function (this: unknown, event: Event) {
              if (signal?.aborted) { removeClose(fn, capture, registration); return; }
              if (once) removeClose(fn, capture, registration);
              try { typeof fn === 'function' ? fn.call(this, event) : fn.handleEvent(event); } catch { listenerFailed = true; }
            },
          };
          let registrations = liveClose.get(fn);
          if (!registrations) { registrations = new Map(); liveClose.set(fn, registrations); }
          registrations.set(capture, registration);
          EventTarget.prototype.addEventListener.call(api, type, registration.wrapper, { capture });
          if (signal) {
            registration.onAbort = () => removeClose(fn, capture, registration);
            signal.addEventListener('abort', registration.onAbort, { once: true });
          }
          replayClose();
          return;
        }
        const wrapper = containing(fn);
        EventTarget.prototype.addEventListener.call(api, type, wrapper, options);
      },
      removeEventListener(type: string, fn: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
        if (!fn) return;
        if (type === 'close') {
          const capture = typeof options === 'boolean' ? options : options?.capture === true;
          const registration = liveClose.get(fn)?.get(capture);
          if (registration) removeClose(fn, capture, registration);
          return;
        }
        const wrapper = containing(fn);
        EventTarget.prototype.removeEventListener.call(api, type, wrapper, options);
      },
    };
    const api: any = Object.defineProperties(new EventTarget(), Object.getOwnPropertyDescriptors(members));
    for (const name of Object.keys(handlers) as (keyof typeof handlers)[]) {
      let attached = false;
      Object.defineProperty(api, name, {
        get: () => handlers[name],
        set: (fn: Handler) => {
          handlers[name] = fn;
          // the on* attribute is itself a listener (attached on first use), so it sees the wrapper as target/currentTarget
          if (fn && !attached) { attached = true; EventTarget.prototype.addEventListener.call(api, name.slice(2), containing(event => handlers[name]?.(event))); }
          if (name === 'onclose' && fn) replayClose();
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
