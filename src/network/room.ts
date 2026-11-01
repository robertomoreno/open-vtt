import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { ADMITTED_PARTICIPANTS, AWARENESS_BYTES, HEARTBEAT_MS, NATIVE_REMOTE_CONNECTIONS } from './limits';
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
const activeRooms = new Set<string>();

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
  let ownsRoom = false;

  const notify = () => { view = undefined; for (const fn of [...listeners]) fn(); };
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
  } else if (activeRooms.has(roomName)) {
    phase = 'failed';
    error = 'This room is already open in this page.';
  } else {
    activeRooms.add(roomName);
    ownsRoom = true;
    void start();
  }

  async function start() {
    let module: typeof import('y-webrtc');
    let protocols: typeof import('y-protocols/awareness');
    try {
      [module, protocols] = await Promise.all([import('y-webrtc'), import('y-protocols/awareness')]);
    } catch {
      fail('The room transport could not be loaded.');
      return;
    }
    if (closed) return;
    runtime = createBoundedRtcRuntime({ now: () => Date.now(), onChange: notify, onError: fail });
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
    awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      if (closed) return;
      for (const client of removed) seen.delete(client);
      refresh([...added, ...updated]);
      notify();
    });
    provider.on('status', ({ connected }: { connected: boolean }) => {
      if (closed) return;
      phase = connected ? 'connected' : 'looking';
      notify();
    });
    provider.on('peers', ({ bcPeers }: { bcPeers: string[] }) => {
      if (closed) return;
      bcPeerCount = bcPeers.length;
      notify();
    });
    let beat = 0;
    const announce = () => awareness.setLocalState({ id: participantId, beat: beat++ });
    announce();
    heartbeat = setInterval(announce, HEARTBEAT_MS);
  }

  return {
    getView() {
      view ??= {
        phase,
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
      if (provider) {
        provider.disconnect();
        provider.destroy();
        if (!options.awareness) provider.awareness.destroy();
      }
      runtime?.close();
      if (ownsRoom) activeRooms.delete(roomName);
      phase = 'closed';
      seen.clear();
      bcPeerCount = 0;
      notify();
    },
  };
}
