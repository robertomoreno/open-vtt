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
  type Transfer = { bytes: number; restart(): void; settle(): void };
  const pendingByPeer = new Map<string, Map<string, Transfer>>();
  let sequence = 0;
  let anonymous = 0;
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

  // One admission path for every action: a transfer is keyed by (action, sender-supplied id) so progress extends only its own deadline.
  const transferId = (metadata: unknown): number | undefined => {
    const t = metadata !== null && typeof metadata === 'object' ? (metadata as { t?: unknown }).t : undefined;
    return typeof t === 'number' && Number.isSafeInteger(t) ? t : undefined;
  };
  function admission(action: string, limit: number, context: { peerId: string; byteLength: number; signal: AbortSignal; metadata?: unknown }): boolean {
    const { peerId, byteLength: bytes, signal } = context;
    if (closed) return false;
    const id = transferId(context.metadata);
    const key = id === undefined ? `${action}:anonymous-${anonymous++}` : `${action}:${id}`;
    const peerTransfers = pendingByPeer.get(peerId) ?? new Map<string, Transfer>();
    if (bytes > limit || peerTransfers.size >= INCOMPLETE_TRANSFERS || pendingBytes + bytes > PENDING_INBOUND_BYTES || peerTransfers.has(key)) { peerError('Peer sent too much pending data.'); return false; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const transfer: Transfer = {
      bytes,
      restart() { clearTimeout(timer); timer = setTimeout(() => { transfer.settle(); peerError('Peer transfer expired.'); closePeer(peerId); }, TRANSFER_TIMEOUT_MS); },
      settle() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', transfer.settle);
        pendingBytes -= bytes;
        const wasHead = peerTransfers.keys().next().value === key;
        peerTransfers.delete(key);
        if (peerTransfers.size === 0 && pendingByPeer.get(peerId) === peerTransfers) pendingByPeer.delete(peerId);
        else if (wasHead && !closed) peerTransfers.values().next().value?.restart();
      },
    };
    // Core runs one bulk transfer per peer at a time and queues the rest in arrival order, so only the head can make progress:
    // its inactivity deadline runs from admission; a queued transfer's starts when it becomes head (or when its own progress arrives).
    const isHead = peerTransfers.size === 0;
    peerTransfers.set(key, transfer);
    pendingByPeer.set(peerId, peerTransfers);
    pendingBytes += bytes;
    if (signal.aborted) { transfer.settle(); return true; }
    if (isHead) transfer.restart();
    signal.addEventListener('abort', transfer.settle, { once: true });
    return true;
  }
  const progressed = (action: string) => (_progress: number, context: { peerId: string; metadata?: unknown }) => {
    const id = transferId(context.metadata);
    if (id !== undefined) pendingByPeer.get(context.peerId)?.get(`${action}:${id}`)?.restart();
  };
  const settleAll = (peerId?: string) => {
    for (const [id, transfers] of [...pendingByPeer]) if (peerId === undefined || id === peerId) for (const transfer of [...transfers.values()]) transfer.settle();
  };

  function wire(joined: Room) {
    const sync = joined.makeAction<Uint8Array>(SYNC_ACTION, {
      onReceive: context => admission(SYNC_ACTION, MESSAGE_BYTES, context),
      onReceiveProgress: progressed(SYNC_ACTION),
      onMessage: (data, context) => {
        if (closed || !peers.has(context.peerId)) return;
        if (!(data instanceof Uint8Array) || data.byteLength > MESSAGE_BYTES) { peerError('Peer sent an invalid update.'); return; }
        try { Y.applyUpdate(doc, data, context.peerId); } catch { peerError('Peer sent an invalid update.'); }
      },
    }) as MessageAction<Uint8Array>;
    const presence = joined.makeAction<any>(PRESENCE_ACTION, {
      onReceive: context => admission(PRESENCE_ACTION, AWARENESS_BYTES, context),
      onReceiveProgress: progressed(PRESENCE_ACTION),
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
      Promise.resolve(action.send(data, { target, metadata: { t: sequence++ } })).catch(() => peerError('Peer send failed.'));
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
      if (import.meta.env.DEV) console.info('[Gather room] peer join', peerId, 'peers=', peers.size + 1);
      if (peers.size >= NATIVE_REMOTE_CONNECTIONS) { closePeer(peerId); return; }
      peers.add(peerId);
      send(sync, Y.encodeStateAsUpdate(doc), peerId);
      send(presence, { id: participantId }, peerId);
      notify();
    };
    joined.onPeerLeave = peerId => {
      if (import.meta.env.DEV) console.info('[Gather room] peer leave', peerId);
      peers.delete(peerId);
      participants.delete(peerId);
      limiters.delete(peerId);
      seen.delete(peerId);
      clearTimeout(expiries.get(peerId));
      expiries.delete(peerId);
      settleAll(peerId);
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
      settleAll();
      const owned = room;
      room = undefined;
      try { void Promise.resolve(owned?.leave()).catch(() => {}); } catch { /* leaving is best effort */ }
      runtime?.close();
      peers.clear();
      seen.clear();
      for (const timer of expiries.values()) clearTimeout(timer);
      expiries.clear();
      pendingBytes = 0;
      notify();
    },
  };
}
