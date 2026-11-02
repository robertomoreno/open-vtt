import * as Y from 'yjs';
import type { JoinRoom, JoinRoomConfig, MessageAction, Room } from '@trystero-p2p/core';
import { roomNetworkConfig } from './config';
import { ACTION_TOKEN_BURST, ACTION_TOKEN_REFILL_PER_SECOND, ADMITTED_PARTICIPANTS, AWARENESS_BYTES, CONTROL_BYTES, CONTROL_ENTRIES, EXPIRY_MS, HEARTBEAT_MS, INCOMPLETE_TRANSFERS, MESSAGE_BYTES, NATIVE_REMOTE_CONNECTIONS, PENDING_ADMISSIONS, PENDING_INBOUND_BYTES, TRANSFER_TIMEOUT_MS } from './limits';
import type { RoomLink } from './room-link';
import { createBoundedRtcRuntime, type RtcConstructors } from './rtc-runtime';

export type RoomTransportView = {
  phase: 'looking' | 'connected' | 'failed' | 'closed';
  openRtcConnections: number;
  presence: Array<{ id: string; seenAt: number }>;
  error: string | null;
};
export type RoomTransport = { getView(): RoomTransportView; subscribe(fn: () => void): () => void; close(): void };
export type RoomTransportOptions = { join?: JoinRoom<JoinRoomConfig>; native?: RtcConstructors };

const participantPattern = /^[A-Za-z0-9_-]{1,64}$/;
const SYNC_ACTION = 'gather-sync-v2';
const PRESENCE_ACTION = 'gather-presence-v2';
const encoder = new TextEncoder();

function bucket(now: () => number) {
  let tokens = ACTION_TOKEN_BURST, at = now();
  return () => {
    const time = now();
    tokens = Math.min(ACTION_TOKEN_BURST, tokens + ((time - at) / 1000) * ACTION_TOKEN_REFILL_PER_SECOND);
    at = time;
    if (tokens < 1) return false;
    tokens--;
    return true;
  };
}

export function createRoomTransport(doc: Y.Doc, link: RoomLink, participantId: string, options: RoomTransportOptions = {}): RoomTransport {
  const listeners = new Set<() => void>();
  const peers = new Set<string>();
  const participants = new Map<string, string>();
  const seen = new Map<string, { id: string; seenAt: number }>();
  const expiries = new Map<string, ReturnType<typeof setTimeout>>();
  const limiters = new Map<string, () => boolean>();
  const pendingByPeer = new Map<string, Set<{ bytes: number; restart(): void; cancel(): void }>>();
  let pendingBytes = 0;
  let pendingHandshakes = 0;
  let phase: 'looking' | 'failed' | 'closed' = 'looking';
  let error: string | null = null;
  let closed = false;
  let runtime: ReturnType<typeof createBoundedRtcRuntime> | undefined;
  let room: Room | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let view: RoomTransportView | undefined;
  let selfSeenAt = Date.now();

  const notify = () => { view = undefined; for (const fn of [...listeners]) fn(); };
  // A fault from one peer closes only that peer; it must not fail the room while other channels are open.
  const peerError = (message: string) => {
    if (closed) return;
    error = message;
    notify();
  };
  const fail = (message: string) => {
    if (closed) return;
    phase = 'failed';
    error = message;
    notify();
  };
  const closePeer = (peerId: string) => { try { room?.getPeers()[peerId]?.close(); } catch { /* already gone */ } };

  const unsupported = typeof RTCPeerConnection !== 'function' || typeof WebSocket !== 'function' || !globalThis.crypto?.subtle;
  if (unsupported) {
    phase = 'failed';
    error = 'This browser does not support WebRTC data channels, WebSocket signaling, or secure-context cryptography.';
  } else {
    void start();
  }

  async function start() {
    let join: JoinRoom<JoinRoomConfig>;
    try {
      join = options.join ?? (await import('./trystero-signaling')).createGatherSignalingStrategy();
    } catch {
      fail('The room transport could not be loaded.');
      return;
    }
    await Promise.resolve();
    if (closed) return;
    runtime = createBoundedRtcRuntime({ native: options.native, now: () => Date.now(), onChange: notify, onError: peerError });
    try {
      room = join({
        appId: 'gather-v2',
        password: link.secret,
        maxReceiveBytes: 8 * 1024 * 1024,
        relayConfig: { urls: roomNetworkConfig.signaling },
        rtcConfig: roomNetworkConfig.rtc,
        rtcPolyfill: runtime.rtcPolyfill,
      }, link.roomId, { onPeerHandshake: handshake, onJoinError: () => peerError('Room discovery failed.') });
      wire(room);
    } catch {
      fail('The room transport could not start.');
      runtime.close();
      return;
    }
    selfSeenAt = Date.now();
    heartbeat = setInterval(beat, HEARTBEAT_MS);
    notify();
  }

  // The handshake exchanges the protocol version and an opaque label; it does not authenticate a person.
  async function handshake(peerId: string, send: (data: any) => Promise<void>, receive: () => Promise<{ data: any }>) {
    if (pendingHandshakes >= PENDING_ADMISSIONS || peers.size + pendingHandshakes >= ADMITTED_PARTICIPANTS - 1) throw new Error('busy');
    pendingHandshakes++;
    try {
      await send({ v: 2, id: participantId });
      const { data } = await receive();
      const keys = data !== null && typeof data === 'object' ? Object.keys(data) : [];
      if (keys.length !== 2 || data.v !== 2 || typeof data.id !== 'string' || !participantPattern.test(data.id)) throw new Error('rejected');
      participants.set(peerId, data.id);
    } finally {
      pendingHandshakes--;
    }
  }

  function admission(peerId: string, bytes: number, signal: AbortSignal): boolean {
    if (closed) return false;
    const set = pendingByPeer.get(peerId) ?? new Set();
    if (bytes > MESSAGE_BYTES || set.size >= INCOMPLETE_TRANSFERS || pendingBytes + bytes > PENDING_INBOUND_BYTES) { peerError('Peer sent too much pending data.'); return false; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const entry = {
      bytes,
      restart() { clearTimeout(timer); timer = setTimeout(() => { settle(); peerError('Peer transfer expired.'); closePeer(peerId); }, TRANSFER_TIMEOUT_MS); },
      cancel() { clearTimeout(timer); },
    };
    const settle = () => {
      if (!set.delete(entry)) return;
      clearTimeout(timer);
      pendingBytes -= bytes;
      if (set.size === 0) pendingByPeer.delete(peerId);
    };
    set.add(entry);
    pendingByPeer.set(peerId, set);
    pendingBytes += bytes;
    entry.restart();
    if (signal.aborted) settle(); else signal.addEventListener('abort', settle, { once: true });
    return true;
  }

  function wire(joined: Room) {
    const sync = joined.makeAction<Uint8Array>(SYNC_ACTION, {
      onReceive: context => admission(context.peerId, context.byteLength, context.signal),
      onReceiveProgress: (_progress, context) => { for (const entry of pendingByPeer.get(context.peerId) ?? []) entry.restart(); },
      onMessage: (data, context) => {
        if (closed || !peers.has(context.peerId)) return;
        if (!(data instanceof Uint8Array) || data.byteLength > MESSAGE_BYTES) { peerError('Peer sent an invalid update.'); return; }
        try { Y.applyUpdate(doc, data, context.peerId); } catch { peerError('Peer sent an invalid update.'); }
      },
    }) as MessageAction<Uint8Array>;
    const presence = joined.makeAction<any>(PRESENCE_ACTION, {
      onReceive: context => context.byteLength <= AWARENESS_BYTES,
      onMessage: (data, context) => {
        if (closed || !peers.has(context.peerId)) return;
        if (!(limiters.get(context.peerId) ?? (limiters.set(context.peerId, bucket(() => Date.now())), limiters.get(context.peerId)!))()) return;
        const known = participants.get(context.peerId);
        if (data === null || typeof data !== 'object' || Object.keys(data).length !== 1 || typeof data.id !== 'string' || data.id !== known) return;
        if (encoder.encode(JSON.stringify(data)).byteLength > AWARENESS_BYTES) return;
        if (!seen.has(context.peerId) && (seen.size >= CONTROL_ENTRIES || seen.size + 1 >= ADMITTED_PARTICIPANTS)) return;
        const peerId = context.peerId;
        seen.set(peerId, { id: data.id, seenAt: Date.now() });
        clearTimeout(expiries.get(peerId));
        expiries.set(peerId, setTimeout(() => { expiries.delete(peerId); if (seen.delete(peerId) && !closed) notify(); }, EXPIRY_MS));
        notify();
      },
    }) as MessageAction<any>;
    const targets = (except?: unknown) => [...peers].filter(peer => peer !== except);
    const send = (action: MessageAction<any>, data: unknown, target: string | string[]) => {
      Promise.resolve(action.send(data, { target })).catch(() => peerError('Peer send failed.'));
    };
    sendPresence = () => { const target = targets(); if (target.length > 0) send(presence, { id: participantId }, target); };
    doc.on('update', onUpdate);
    function onUpdate(update: Uint8Array, origin: unknown) {
      if (closed) return;
      const target = targets(origin);
      if (target.length > 0) send(sync, update, target);
    }
    removeUpdate = () => doc.off('update', onUpdate);
    joined.onPeerJoin = peerId => {
      if (closed) return;
      if (peers.size >= NATIVE_REMOTE_CONNECTIONS) { closePeer(peerId); return; }
      peers.add(peerId);
      send(sync, Y.encodeStateAsUpdate(doc), peerId);
      send(presence, { id: participantId }, peerId);
      notify();
    };
    joined.onPeerLeave = peerId => {
      peers.delete(peerId);
      participants.delete(peerId);
      limiters.delete(peerId);
      seen.delete(peerId);
      clearTimeout(expiries.get(peerId));
      expiries.delete(peerId);
      for (const entry of pendingByPeer.get(peerId) ?? []) { entry.cancel(); pendingBytes -= entry.bytes; }
      pendingByPeer.delete(peerId);
      if (!closed) notify();
    };
  }
  let sendPresence = () => {};
  let removeUpdate = () => {};

  function beat() {
    if (closed) return;
    selfSeenAt = Date.now();
    sendPresence();
    notify();
  }

  return {
    getView() {
      view ??= {
        phase: phase !== 'looking' ? phase : (runtime?.getOpenCount() ?? 0) > 0 ? 'connected' : 'looking',
        openRtcConnections: runtime?.getOpenCount() ?? 0,
        presence: closed || phase === 'failed' || !room ? [] : [{ id: participantId, seenAt: selfSeenAt }, ...seen.values()].sort((a, b) => a.id.localeCompare(b.id)).map(entry => ({ ...entry })),
        error,
      };
      return view;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    close() {
      if (closed) return;
      closed = true;
      phase = 'closed';
      if (heartbeat !== undefined) clearInterval(heartbeat);
      removeUpdate();
      for (const set of pendingByPeer.values()) for (const entry of set) entry.cancel();
      const owned = room;
      room = undefined;
      try { void Promise.resolve(owned?.leave()).catch(() => {}); } catch { /* leaving is best effort */ }
      runtime?.close();
      for (const set of pendingByPeer.values()) set.clear();
      pendingByPeer.clear();
      peers.clear();
      seen.clear();
      for (const timer of expiries.values()) clearTimeout(timer);
      expiries.clear();
      pendingBytes = 0;
      notify();
    },
  };
}
