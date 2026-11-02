import { vi } from 'vitest';
import type { JoinRoom, JoinRoomConfig } from '@trystero-p2p/core';

// Deterministic in-memory signaling topics (stands in for the public WSS relay) and a fake native RTC pair.
// Unit-level harness for the real Trystero Core scheduler; it is not browser or public-endpoint evidence.
export type Bus = { subs: Map<string, Set<(topic: string, msg: any) => void>> };
export const createBus = (): Bus => ({ subs: new Map() });

export async function loadCoreJoiner(bus: Bus): Promise<JoinRoom<JoinRoomConfig>> {
  vi.resetModules();
  const core = await import('@trystero-p2p/core');
  return core.createTopicStrategy<Bus, JoinRoomConfig>({
    init: () => bus,
    subscribeTopic: (b, topic, onMessage) => {
      const set = b.subs.get(topic) ?? new Set();
      const cb = (t: string, m: any) => { void onMessage(t, m); };
      set.add(cb); b.subs.set(topic, set);
      return () => { set.delete(cb); };
    },
    publishTopic: (b, topic, msg) => { for (const cb of [...(b.subs.get(topic) ?? [])]) queueMicrotask(() => cb(topic, msg)); },
  });
}

export type Net = {
  gated: Set<string>; queues: Map<string, Array<() => void>>; pcs: Map<string, any>;
  gate(name: string): void; open(name: string): void; pending(name: string): number; deliver(name: string, count: number): void;
};
export function createNet(): Net {
  const net: Net = {
    gated: new Set(), queues: new Map(), pcs: new Map(),
    gate(name) { net.gated.add(name); },
    open(name) { net.gated.delete(name); net.deliver(name, Infinity); },
    pending: name => net.queues.get(name)?.length ?? 0,
    deliver(name, count) { const q = net.queues.get(name) ?? []; for (let i = 0; i < count && q.length > 0; i++) q.shift()!(); },
  };
  return net;
}

let ids = 0;
export function createFakeRtc(net: Net, owner: string) {
  class Channel extends EventTarget {
    label = 'data'; ordered = true; maxRetransmits: number | null = null; maxPacketLifeTime: number | null = null;
    readyState = 'connecting'; bufferedAmount = 0; bufferedAmountLowThreshold = 0; binaryType = 'blob';
    remote?: Channel; owner = '';
    send(data: ArrayBufferView | ArrayBuffer) {
      const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : new Uint8Array(data as ArrayBuffer).slice();
      const target = this.remote;
      if (!target || this.readyState !== 'open') return;
      const deliver = () => { if (target.readyState === 'open') target.dispatchEvent(new MessageEvent('message', { data: bytes.buffer })); };
      const queue = net.queues.get(target.owner) ?? [];
      net.queues.set(target.owner, queue);
      if (net.gated.has(target.owner)) queue.push(deliver); else queueMicrotask(deliver);
    }
    close() {
      if (this.readyState === 'closed') return;
      this.readyState = 'closed';
      queueMicrotask(() => this.dispatchEvent(new Event('close')));
      const remote = this.remote;
      if (remote && remote.readyState !== 'closed') { remote.readyState = 'closed'; queueMicrotask(() => remote.dispatchEvent(new Event('close'))); }
    }
  }
  return class FakePc extends EventTarget {
    id = `pc${ids++}`; localDescription: any = null; remoteDescription: any = null; signalingState = 'stable';
    connectionState = 'new'; iceConnectionState = 'new'; iceGatheringState = 'new'; closedCount = 0;
    channel?: Channel; remoteId?: string; role?: 'offer' | 'answer';
    constructor() { super(); net.pcs.set(this.id, this); }
    createDataChannel() { const c = new Channel(); c.owner = owner; this.channel = c; return c; }
    async setLocalDescription(description?: any) {
      if (description?.type === 'rollback') { this.signalingState = 'stable'; return; }
      const type = this.remoteDescription ? 'answer' : 'offer';
      this.localDescription = { type, sdp: `v=0\r\na=rtpmap:fake\r\na=pc:${this.id}` };
      this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
    }
    async setRemoteDescription(description: any) {
      this.remoteDescription = description;
      this.remoteId = /a=pc:(\S+)/.exec(description.sdp)![1];
      if (description.type === 'offer') this.signalingState = 'have-remote-offer';
      else { this.signalingState = 'stable'; this.connect(net.pcs.get(this.remoteId)); }
    }
    async addIceCandidate() {}
    restartIce() {}
    connect(other: any) {
      const local = this.channel!;
      const remote = new Channel(); remote.owner = other.channel?.owner ?? '';
      remote.owner = (other as any).ownerName;
      local.remote = remote; remote.remote = local;
      other.channel = remote;
      for (const pc of [this, other]) { pc.connectionState = 'connected'; pc.iceConnectionState = 'connected'; }
      queueMicrotask(() => {
        const event: any = new Event('datachannel'); event.channel = remote; other.dispatchEvent(event);
        local.readyState = 'open'; remote.readyState = 'open';
        local.dispatchEvent(new Event('open')); remote.dispatchEvent(new Event('open'));
        this.onconnectionstatechange?.(new Event('connectionstatechange')); other.onconnectionstatechange?.(new Event('connectionstatechange'));
      });
    }
    onconnectionstatechange: ((e: Event) => void) | null = null;
    ownerName = owner;
    close() { this.closedCount++; this.connectionState = 'closed'; this.iceConnectionState = 'closed'; this.channel?.close(); }
  };
}
