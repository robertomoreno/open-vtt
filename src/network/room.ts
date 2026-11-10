import * as Y from 'yjs';
import type { JoinRoom, JoinRoomConfig, MessageAction, RequestAction, Room } from '@trystero-p2p/core';
import { validateAudioTransferMeta, type AudioPositionBody, type AudioTransferMeta } from '../game/audio';
import { rtcConfiguration } from './config';
import { ACTION_TOKEN_BURST, ACTION_TOKEN_REFILL_PER_SECOND, ADMITTED_PARTICIPANTS, AUDIO_BYTES, AUDIO_MAX_DURATION_MS, AWARENESS_BYTES, CONTROL_BYTES, CONTROL_ENTRIES, EXPIRY_MS, HEARTBEAT_MS, INCOMPLETE_TRANSFERS, MESSAGE_BYTES, NATIVE_REMOTE_CONNECTIONS, PENDING_ADMISSIONS, PENDING_INBOUND_BYTES, PROBE_TIMEOUT_MS, TRANSFER_TIMEOUT_MS } from './limits';
import type { RoomLink } from './room-link';
import { createBoundedRtcRuntime, type RtcConstructors } from './rtc-runtime';
import { signalingConfig } from './signaling/config';
import { resolveSignalingPlan } from './signaling/resolve';
import type { SignalingPlan } from './signaling/types';

export type RoomTransportView = {
  phase: 'looking' | 'connected' | 'failed' | 'closed';
  openRtcConnections: number;
  presence: Array<{ id: string; seenAt: number }>;
  error: string | null;
};
export type AudioPositionResult = { peerId: string; position: AudioPositionBody; rttMs: number };
export type RoomAudioHandlers = {
  onTrack?: (bytes: Uint8Array, meta: AudioTransferMeta, peerId: string) => void;
  onProgress?: (fraction: number, meta: AudioTransferMeta, peerId: string) => void;
  onWho?: (trackId: string, peerId: string) => boolean | Promise<boolean>;
  onFetch?: (trackId: string, peerId: string) => boolean | Promise<boolean>;
  onPosition?: (trackId: string, peerId: string) => AudioPositionBody | null | Promise<AudioPositionBody | null>;
};
export type RoomAudio = {
  setHandlers(handlers: RoomAudioHandlers): void;
  /**
   * Sends one audio payload with `AUDIO_BYTES`-bounded metadata. The metadata is validated here,
   * so the parameter accepts any shape; an invalid payload or an unwired room rejects the promise,
   * and callers must handle that failure.
   */
  sendTrack(bytes: Uint8Array, meta: unknown, target?: string | string[], onProgress?: (fraction: number, peerId: string) => void): Promise<void>;
  requestHolders(trackId: string): Promise<string[]>;
  requestFetch(trackId: string, peerId: string): Promise<boolean>;
  requestPosition(trackId: string, preferredPeer?: string): Promise<AudioPositionResult | null>;
};
export type RoomTransport = { getView(): RoomTransportView; subscribe(fn: () => void): () => void; close(): void; audio: RoomAudio };
export type RoomTransportOptions = { join?: JoinRoom<JoinRoomConfig>; plan?: SignalingPlan; native?: RtcConstructors };

const participantPattern = /^[A-Za-z0-9_-]{1,64}$/;
const audioIdPattern = /^[0-9a-f]{64}$/;
const SYNC_ACTION = 'gather-sync-v2';
const PRESENCE_ACTION = 'gather-presence-v2';
const AUDIO_ACTION = 'gather-audio-v1';
const AUDIO_WHO_ACTION = 'gather-audio-who-v1';
const AUDIO_FETCH_ACTION = 'gather-audio-fetch-v1';
const AUDIO_POSITION_ACTION = 'gather-audio-position-v1';
const encoder = new TextEncoder();

// Peer-supplied audio metadata and positions are untrusted: return null instead of throwing.
function audioMeta(value: unknown): AudioTransferMeta | null {
  try { return validateAudioTransferMeta(value); } catch { return null; }
}
function audioTrackId(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'trackId') return null;
  const trackId = (value as { trackId?: unknown }).trackId;
  return typeof trackId === 'string' && audioIdPattern.test(trackId) ? trackId : null;
}
function audioPositionBody(value: unknown, trackId: string): AudioPositionBody | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== 'playing' || keys[1] !== 'positionMs' || keys[2] !== 'trackId') return null;
  const body = value as { trackId?: unknown; playing?: unknown; positionMs?: unknown };
  if (body.trackId !== trackId || typeof body.playing !== 'boolean') return null;
  const positionMs = body.positionMs;
  if (!Number.isSafeInteger(positionMs) || (positionMs as number) < 0 || (positionMs as number) > AUDIO_MAX_DURATION_MS) return null;
  return { trackId, playing: body.playing, positionMs: positionMs as number };
}

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
  const audioLimiters = new Map<string, () => boolean>();
  let audioHandlers: RoomAudioHandlers = {};
  let audioTrack: MessageAction<Uint8Array> | undefined;
  let audioWho: RequestAction<{ trackId: string }, { has: boolean }> | undefined;
  let audioFetch: RequestAction<{ trackId: string }, { accepted: boolean }> | undefined;
  let audioPosition: RequestAction<{ trackId: string }, AudioPositionBody | null> | undefined;
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
    if (import.meta.env.DEV) console.warn('[Gather room] transport error:', message);
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
    let plan: SignalingPlan;
    try {
      plan = options.plan ?? await resolveSignalingPlan(signalingConfig);
    } catch {
      fail('The room transport could not be loaded.');
      return;
    }
    await Promise.resolve();
    if (closed) return;
    const join = options.join ?? plan.join;
    runtime = createBoundedRtcRuntime({ native: options.native, now: () => Date.now(), onChange: notify, onError: peerError });
    try {
      room = join({
        ...plan.base,
        password: link.secret,
        relayConfig: plan.relayConfig,
        rtcConfig: rtcConfiguration,
        rtcPolyfill: runtime.rtcPolyfill,
        // When the plan's signaling is loopback every peer is on this machine,
        // so the browser's mDNS-obfuscated host candidates can safely become
        // 127.0.0.1.
        ...(plan.allowsLoopbackCandidateFallback ? { _test_only_mdnsHostFallbackToLoopback: true } : {}),
      }, link.roomId, {
        onPeerHandshake: handshake,
        onJoinError: (details) => {
          if (import.meta.env.DEV) console.warn('[Gather room] join error:', details.error, 'peer=', details.peerId);
          peerError('Room discovery failed.');
        },
      });
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
    if (import.meta.env.DEV) console.info('[Gather room] handshake start', peerId);
    if (pendingHandshakes >= PENDING_ADMISSIONS || peers.size + pendingHandshakes >= ADMITTED_PARTICIPANTS - 1) { if (import.meta.env.DEV) console.warn('[Gather room] handshake busy', peerId); throw new Error('busy'); }
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

  // Audio requests get their own per-peer budget so holder/position polling never starves presence.
  const audioLimiter = (peerId: string): boolean => {
    let limiter = audioLimiters.get(peerId);
    if (limiter === undefined) { limiter = bucket(() => Date.now()); audioLimiters.set(peerId, limiter); }
    return limiter();
  };
  // A local handler fault is a UI bug, not a peer fault: never let it break the transport.
  const safely = (fn: () => void) => { try { fn(); } catch { /* ignored on purpose */ } };

  const audio: RoomAudio = {
    setHandlers(handlers) { audioHandlers = { ...handlers }; },
    async sendTrack(bytes, meta, target, onProgress) {
      const valid = audioMeta(meta);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > AUDIO_BYTES || valid === null || valid.size !== bytes.byteLength) throw new Error('Invalid audio transfer.');
      const action = audioTrack;
      if (action === undefined) throw new Error('The room connection is not ready.');
      await action.send(bytes, {
        ...(target === undefined ? {} : { target }),
        metadata: valid,
        ...(onProgress === undefined ? {} : { onProgress: (fraction: number, context: { peerId: string }) => onProgress(fraction, context.peerId) }),
      });
    },
    async requestHolders(trackId) {
      const id = audioTrackId({ trackId });
      const action = audioWho;
      if (id === null || action === undefined) return [];
      const targets = [...peers];
      if (targets.length === 0) return [];
      try {
        // An unresponsive peer must not hold the poll open forever.
        const results = await action.requestMany({ trackId: id }, { targets, timeoutMs: PROBE_TIMEOUT_MS });
        const holders: string[] = [];
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          const value: unknown = result.value;
          if (value !== null && typeof value === 'object' && (value as { has?: unknown }).has === true) holders.push(result.peerId);
        }
        return holders;
      } catch { return []; }
    },
    async requestFetch(trackId, peerId) {
      const id = audioTrackId({ trackId });
      const action = audioFetch;
      if (id === null || action === undefined || !peers.has(peerId)) return false;
      try {
        const value: unknown = await action.request({ trackId: id }, { target: peerId, timeoutMs: PROBE_TIMEOUT_MS });
        return value !== null && typeof value === 'object' && (value as { accepted?: unknown }).accepted === true;
      } catch { return false; }
    },
    async requestPosition(trackId, preferredPeer) {
      const id = audioTrackId({ trackId });
      const action = audioPosition;
      if (id === null || action === undefined) return null;
      // The preferred peer gets at most half the probe budget, so a silent peer still leaves time for the fallback.
      const deadline = Date.now() + PROBE_TIMEOUT_MS;
      const preferredBudget = Math.floor(PROBE_TIMEOUT_MS / 2);
      if (preferredPeer !== undefined && peers.has(preferredPeer)) {
        const started = Date.now();
        try {
          const value: unknown = await action.request({ trackId: id }, { target: preferredPeer, timeoutMs: preferredBudget });
          const position = audioPositionBody(value, id);
          if (position !== null) return { peerId: preferredPeer, position, rttMs: Date.now() - started };
        } catch { /* timed out or rejected: the fallback below uses the remaining budget */ }
      }
      const targets = [...peers].filter(peer => peer !== preferredPeer);
      if (targets.length === 0) return null;
      const answeredAt = new Map<string, number>();
      const started = Date.now();
      try {
        const results = await action.requestMany({ trackId: id }, {
          targets,
          timeoutMs: Math.max(1, deadline - Date.now()),
          onResult: result => { answeredAt.set(result.peerId, Date.now()); },
        });
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          const position = audioPositionBody(result.value, id);
          if (position !== null) return { peerId: result.peerId, position, rttMs: (answeredAt.get(result.peerId) ?? Date.now()) - started };
        }
      } catch { /* nobody answered */ }
      return null;
    },
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
    const audioProgressed = progressed(AUDIO_ACTION);
    const audioProgress = (progress: number, context: { peerId: string; metadata?: unknown }) => {
      audioProgressed(progress, context);
      // Audio metadata carries no transfer id, so an unlabelled progress event belongs to this
      // peer's in-flight audio transfer (core runs one bulk transfer per peer at a time).
      if (transferId(context.metadata) === undefined) {
        const transfers = pendingByPeer.get(context.peerId);
        const key = transfers?.keys().next().value;
        if (transfers !== undefined && typeof key === 'string' && key.startsWith(`${AUDIO_ACTION}:`)) transfers.get(key)?.restart();
      }
    };
    audioTrack = joined.makeAction<Uint8Array>(AUDIO_ACTION, {
      // Validate the metadata before registering a transfer, so malformed payloads cannot spend the shared budget.
      onReceive: context => {
        const meta = audioMeta(context.metadata);
        return meta !== null && meta.size === context.byteLength && admission(AUDIO_ACTION, AUDIO_BYTES, context);
      },
      onReceiveProgress: (progress, context) => {
        if (closed || !peers.has(context.peerId)) return;
        audioProgress(progress, context);
        const meta = audioMeta(context.metadata);
        if (meta !== null) safely(() => audioHandlers.onProgress?.(progress, meta, context.peerId));
      },
      onMessage: (data, context) => {
        if (closed || !peers.has(context.peerId)) return;
        const meta = audioMeta(context.metadata);
        if (!(data instanceof Uint8Array) || data.byteLength > AUDIO_BYTES || data.byteLength < 1 || meta === null || meta.size !== data.byteLength) { peerError('Peer sent invalid audio.'); return; }
        safely(() => audioHandlers.onTrack?.(data, meta, context.peerId));
      },
    }) as MessageAction<Uint8Array>;
    audioWho = joined.makeAction<{ trackId: string }, { has: boolean }>(AUDIO_WHO_ACTION, {
      kind: 'request',
      onRequest: async (data, context) => {
        const id = audioTrackId(data);
        if (id === null || !peers.has(context.peerId) || !audioLimiter(context.peerId)) return { has: false };
        try { return { has: (await audioHandlers.onWho?.(id, context.peerId)) === true }; } catch { return { has: false }; }
      },
    });
    audioFetch = joined.makeAction<{ trackId: string }, { accepted: boolean }>(AUDIO_FETCH_ACTION, {
      kind: 'request',
      onRequest: async (data, context) => {
        const id = audioTrackId(data);
        if (id === null || !peers.has(context.peerId) || !audioLimiter(context.peerId)) return { accepted: false };
        try { return { accepted: (await audioHandlers.onFetch?.(id, context.peerId)) === true }; } catch { return { accepted: false }; }
      },
    });
    audioPosition = joined.makeAction<{ trackId: string }, AudioPositionBody | null>(AUDIO_POSITION_ACTION, {
      kind: 'request',
      onRequest: async (data, context) => {
        const id = audioTrackId(data);
        if (id === null || !peers.has(context.peerId) || !audioLimiter(context.peerId)) return null;
        try { return audioPositionBody(await audioHandlers.onPosition?.(id, context.peerId), id); } catch { return null; }
      },
    });
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
      audioLimiters.delete(peerId);
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
    audio,
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
      audioLimiters.clear();
      for (const timer of expiries.values()) clearTimeout(timer);
      expiries.clear();
      pendingBytes = 0;
      notify();
    },
  };
}
