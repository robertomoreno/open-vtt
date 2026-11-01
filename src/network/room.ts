import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { ADMITTED_PARTICIPANTS, AWARENESS_BYTES, AWARENESS_TOMBSTONES, HEARTBEAT_MS, KEY_SETTLE_MS, NATIVE_REMOTE_CONNECTIONS } from './limits';
import { roomNetworkConfig } from './config';
import type { RoomLink } from './room-link';
import { createBoundedRtcRuntime } from './rtc-runtime';

export type RoomTransportView = {
  phase: 'looking' | 'connected' | 'failed' | 'closed';
  openRtcConnections: number;
  bcPeerCount: number;
  presence: Array<{ id: string; seenAt: number }>;
  error: string | null;
};
export type RoomTransport = { getView(): RoomTransportView; subscribe(fn: () => void): () => void; close(): void };

const participantPattern = /^[A-Za-z0-9_-]{1,64}$/;
type RoomLock = { settled: Promise<void> | null; resolve?: () => void };
const roomLocks = new Map<string, RoomLock>();

export type RoomTransportOptions = { awareness?: Awareness };

export function createRoomTransport(doc: Y.Doc, link: RoomLink, participantId: string, options: RoomTransportOptions = {}): RoomTransport {
  const roomName = 'gather-v2:' + link.roomId;
  const listeners = new Set<() => void>();
  const seen = new Map<number, { id: string; seenAt: number }>();
  let phase: RoomTransportView['phase'] = 'looking';
  let error: string | null = null;
  let bcPeerCount = 0;
  let closed = false;
  let runtime: ReturnType<typeof createBoundedRtcRuntime> | undefined;
  let provider: any;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let view: RoomTransportView | undefined;
  let lock: RoomLock | undefined;
  let previous: Promise<void> | null = null;
  let opened = false;
  let started = false;

  const notify = () => { view = undefined; for (const fn of [...listeners]) fn(); };
  // A guard failure closes only the offending peer; it must not mark the whole room failed while other channels are open.
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

  const unsupported = typeof RTCPeerConnection !== 'function' || typeof RTCSessionDescription !== 'function' || typeof RTCIceCandidate !== 'function' || typeof WebSocket !== 'function' || !globalThis.crypto?.subtle;
  if (unsupported) {
    phase = 'failed';
    error = 'This browser does not support WebRTC data channels, WebSocket signaling, or secure-context cryptography.';
  } else if (roomLocks.get(roomName) && !roomLocks.get(roomName)!.settled) {
    phase = 'failed';
    error = 'This room is already open in this page.';
  } else {
    previous = roomLocks.get(roomName)?.settled ?? null;
    lock = { settled: null };
    roomLocks.set(roomName, lock);
    void start();
  }

  function release() {
    if (!lock) return;
    if (roomLocks.get(roomName) === lock) roomLocks.delete(roomName);
    lock.resolve?.();
  }

  async function start() {
    started = true;
    if (previous) await previous;
    if (closed) { release(); return; }
    let module: typeof import('y-webrtc');
    let protocols: typeof import('y-protocols/awareness');
    try {
      [module, protocols] = await Promise.all([import('y-webrtc'), import('y-protocols/awareness')]);
    } catch {
      fail('The room transport could not be loaded.');
      release();
      return;
    }
    if (closed) { release(); return; }
    runtime = createBoundedRtcRuntime({ now: () => Date.now(), onChange: notify, onError: peerError });
    try {
      provider = new module.WebrtcProvider(roomName, doc, {
        password: link.secret,
        awareness: options.awareness ?? new protocols.Awareness(doc),
        signaling: roomNetworkConfig.signaling,
        maxConns: NATIVE_REMOTE_CONNECTIONS,
        peerOpts: { wrtc: runtime.wrtc, config: roomNetworkConfig.rtc },
      });
    } catch {
      fail('The room transport could not start.');
      release();
      return;
    }
    const awareness = provider.awareness;
    const encoder = new TextEncoder();
    // y-protocols stores remote states before it emits 'update'; enforce retained-state bounds here.
    const refresh = (clients: number[]) => {
      const states = awareness.getStates() as Map<number, unknown>;
      const reject: number[] = [];
      for (const client of clients) {
        const state = states.get(client) as { id?: unknown } | undefined;
        const valid = state !== undefined && state !== null && typeof state.id === 'string' && participantPattern.test(state.id) && encoder.encode(JSON.stringify(state)).byteLength <= AWARENESS_BYTES;
        const admitted = valid && (seen.has(client) || seen.size < ADMITTED_PARTICIPANTS);
        if (admitted) {
          seen.set(client, { id: state.id as string, seenAt: Date.now() });
        } else {
          seen.delete(client);
          if (state !== undefined && client !== awareness.clientID) reject.push(client);
        }
      }
      if (reject.length > 0) protocols.removeAwarenessStates(awareness, reject, 'gather-bounds');
    };
    // y-protocols records a clock for every client it has ever seen, even with a null state and without emitting 'update'.
    // Keep those clocks (they reject stale replays) but cap how many stateless ones are retained, at insertion time.
    const states = awareness.getStates() as Map<number, unknown>;
    const oldMeta = awareness.meta as Map<number, { clock: number; lastUpdated: number }>;
    const trimMeta = (meta: Map<number, { clock: number; lastUpdated: number }>) => {
      let stateless = 0;
      for (const key of meta.keys()) if (!states.has(key) && key !== awareness.clientID) stateless++;
      for (const key of [...meta.keys()]) {
        if (stateless <= AWARENESS_TOMBSTONES) break;
        if (!states.has(key) && key !== awareness.clientID) { meta.delete(key); stateless--; }
      }
    };
    const bounded = new class extends Map<number, { clock: number; lastUpdated: number }> {
      override set(client: number, value: { clock: number; lastUpdated: number }) {
        super.set(client, value);
        trimMeta(this);
        return this;
      }
    }();
    for (const [client, value] of oldMeta) Map.prototype.set.call(bounded, client, value);
    awareness.meta = bounded;
    awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      if (closed) return;
      for (const client of removed) seen.delete(client);
      refresh([...added, ...updated]);
      // states rejected above became stateless; trim after y-webrtc's own update handler has encoded them
      queueMicrotask(() => { if (!closed) trimMeta(awareness.meta); });
      notify();
    });
    // status.connected only means discovery is enabled; the phase follows actual native channel opens instead.
    provider.on('status', () => { opened = true; });
    provider.on('peers', ({ bcPeers }: { bcPeers: string[] }) => {
      if (closed) return;
      bcPeerCount = bcPeers.length;
      notify();
    });
    let beat = 0;
    const announce = () => { awareness.setLocalState({ id: participantId, beat: beat++ }); };
    announce();
    heartbeat = setInterval(announce, HEARTBEAT_MS);
  }

  return {
    getView() {
      view ??= {
        phase: phase === 'looking' && (runtime?.getOpenCount() ?? 0) > 0 ? 'connected' : phase,
        openRtcConnections: runtime?.getOpenCount() ?? 0,
        bcPeerCount,
        presence: [...seen.values()].sort((a, b) => a.id.localeCompare(b.id)).map(entry => ({ ...entry })),
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
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (lock) { const current = lock; current.settled = new Promise<void>(resolve => { current.resolve = resolve; }); }
      if (provider) {
        const owned = provider;
        owned.disconnect();
        let finished = false;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          if (finished) return;
          finished = true;
          if (deadline !== undefined) clearTimeout(deadline);
          owned.destroy();
          if (!options.awareness) owned.awareness.destroy();
          // upstream waits for key derivation inside destroy(); release the lock only after that microtask has run
          queueMicrotask(release);
        };
        // before the key resolves upstream has no room yet; wait for its first status event so destroy() tears down the room it opens
        // If key derivation fails or never settles upstream emits no status; force teardown after a deadline so the lock is not held forever.
        if (opened) finish(); else { owned.once('status', finish); deadline = setTimeout(finish, KEY_SETTLE_MS); }
      } else if (!started) release();
      runtime?.close();
      phase = 'closed';
      seen.clear();
      bcPeerCount = 0;
      notify();
    },
  };
}
