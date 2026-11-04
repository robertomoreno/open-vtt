import * as Y from 'yjs';
import type { WorkspaceSnapshot } from '../../src/game/sync-types';
import type { RoomLink } from '../../src/network/room-link';
import type { RoomTransport, RoomTransportView } from '../../src/network/room';
import { createPeerSession } from '../../src/session/peer';
import type { PeerSession } from '../../src/session/peer-types';
import { namedRuntime } from './workspace';

/**
 * A deterministic in-process room hub for unit tests. Linked peers apply each other's
 * Y.Doc updates on `flush()` and exchange virtual-clock presence; `advance()` moves the
 * shared clock so expiry and succession become observable without real timers.
 *
 * This is injected through `createTransport` for unit-test determinism only. It is not
 * browser acceptance and it never replaces the real RTC path in end-to-end tests.
 */

type Delivery = { to: string; update: Uint8Array; origin: string };
type HubEntry = {
  label: string;
  doc: Y.Doc;
  participantId: string;
  link: RoomLink;
  closed: boolean;
  lastSeen: number;
  listeners: Set<() => void>;
};

export type SessionHarness = {
  add(label: string, initial: WorkspaceSnapshot | null, rememberedId?: string | null): PeerSession;
  session(label: string): PeerSession;
  stageOf(label: string): Y.Doc;
  connect(...labels: string[]): void;
  disconnect(label: string): void;
  advance(ms: number): void;
  flush(): Promise<void>;
  destroy(): void;
};

export function createSessionHarness(): SessionHarness {
  let clock = 0;
  const sessions = new Map<string, PeerSession>();
  const entries = new Map<string, HubEntry>();
  const docs = new Map<string, Y.Doc>();
  const channels = new Map<string, Set<string>>();
  const owners = new Map<string, string>();
  const queue: Delivery[] = [];

  const entry = (label: string) => {
    const found = entries.get(label);
    if (!found || found.closed) throw new Error(`${label} has no live transport; call connect() first.`);
    return found;
  };
  const linked = (label: string) => [...(channels.get(label) ?? [])].filter(other => {
    const peer = entries.get(other);
    return peer !== undefined && !peer.closed;
  });
  const notify = (target: HubEntry) => { for (const fn of [...target.listeners]) fn(); };

  function unlink(label: string) {
    for (const other of channels.get(label) ?? []) channels.get(other)?.delete(label);
    channels.delete(label);
  }

  /** The injected transport: registers with the hub and broadcasts doc updates to linked peers. */
  function transportFor(label: string) {
    return (doc: Y.Doc, link: RoomLink, participantId: string): RoomTransport => {
      const previous = entries.get(label);
      if (previous && !previous.closed) previous.closed = true;
      const target: HubEntry = { label, doc, participantId, link, closed: false, lastSeen: clock, listeners: new Set() };
      entries.set(label, target);
      docs.set(label, doc);
      const onUpdate = (update: Uint8Array) => {
        if (target.closed) return;
        for (const other of linked(label)) queue.push({ to: other, update, origin: participantId });
      };
      doc.on('update', onUpdate);
      return {
        getView(): RoomTransportView {
          const peers = linked(label).map(other => entries.get(other)!);
          const presence = target.closed
            ? []
            : [{ id: participantId, seenAt: target.lastSeen }, ...peers.map(peer => ({ id: peer.participantId, seenAt: peer.lastSeen }))]
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          return {
            phase: target.closed ? 'closed' : peers.length > 0 ? 'connected' : 'looking',
            openRtcConnections: peers.length,
            presence,
            error: null,
          };
        },
        subscribe(fn) { target.listeners.add(fn); return () => { target.listeners.delete(fn); }; },
        close() {
          if (target.closed) return;
          target.closed = true;
          doc.off('update', onUpdate);
          const peers = linked(label).map(other => entries.get(other)!);
          unlink(label);
          for (const peer of peers) notify(peer);
          notify(target);
        },
      };
    };
  }

  function ensureTransport(label: string, link: RoomLink) {
    const session = sessions.get(label);
    if (!session) throw new Error(`Unknown session ${label}.`);
    if (entries.has(label) && !entries.get(label)!.closed) return;
    if (owners.get(link.roomId) === label) session.openRoom();
    else session.joinRoom(link);
  }

  return {
    add(label, initial, rememberedId = null) {
      const session = createPeerSession({
        initial,
        rememberedPlayerId: rememberedId,
        runtime: namedRuntime(label),
        now: () => clock,
        createTransport: transportFor(label),
      });
      sessions.set(label, session);
      return session;
    },
    session(label) {
      const session = sessions.get(label);
      if (!session) throw new Error(`Unknown session ${label}.`);
      return session;
    },
    stageOf(label) {
      const doc = docs.get(label);
      if (!doc) throw new Error(`${label} never created a transport; call connect() first.`);
      return doc;
    },
    connect(...labels: string[]) {
      if (labels.length === 0) return;
      // The room link: an existing one wins; otherwise the first label with a game opens it.
      let link: RoomLink | null = null;
      for (const label of labels) {
        const existing = sessions.get(label)?.getRoomLink();
        if (existing) { link = existing; break; }
      }
      if (!link) {
        for (const label of labels) {
          const opened = sessions.get(label)?.openRoom();
          if (opened) { link = opened; owners.set(opened.roomId, label); break; }
        }
      }
      if (!link) throw new Error('No listed participant can open the room.');
      for (const label of labels) ensureTransport(label, link);
      for (const x of labels) {
        const set = channels.get(x) ?? new Set<string>();
        channels.set(x, set);
        for (const y of labels) if (x !== y) set.add(y);
      }
      // Establishing a channel exchanges the full doc state both ways, like a real peer join.
      for (const x of labels) {
        entry(x).lastSeen = clock;
        for (const y of labels) {
          if (x === y) continue;
          queue.push({ to: y, update: Y.encodeStateAsUpdate(entry(x).doc), origin: entry(x).participantId });
        }
      }
      for (const label of labels) notify(entry(label));
    },
    disconnect(label) {
      // A network-level cut: the session keeps its transport and workspace, but the channel
      // is gone, so the peer's presence freezes at the cut for everyone else.
      const target = entries.get(label);
      if (!target || target.closed) return;
      const peers = linked(label).map(other => entries.get(other)!);
      unlink(label);
      notify(target);
      for (const peer of peers) notify(peer);
    },
    advance(ms) {
      clock += ms;
      // A local heartbeat is a local fact: an open transport keeps seeing itself even when
      // every channel is cut, exactly like the real transport's periodic beat.
      for (const target of entries.values()) if (!target.closed) target.lastSeen = clock;
      // Succession and expiry are tick-driven; reading the view runs the tick deterministically.
      for (const session of sessions.values()) session.getView();
    },
    async flush() {
      for (let pass = 0; pass < 64; pass++) {
        const deliveries = queue.splice(0, queue.length);
        for (const delivery of deliveries) {
          const target = entries.get(delivery.to);
          if (!target || target.closed || delivery.origin === target.participantId) continue;
          Y.applyUpdate(target.doc, delivery.update, delivery.origin);
        }
        for (const target of entries.values()) {
          if (target.closed) continue;
          target.lastSeen = clock;
          notify(target);
        }
        await Promise.resolve();
        if (queue.length === 0 && pass > 0) return;
      }
      throw new Error('Room delivery did not settle.');
    },
    destroy() {
      for (const session of sessions.values()) session.close();
      sessions.clear();
      entries.clear();
      docs.clear();
      channels.clear();
      owners.clear();
      queue.length = 0;
    },
  };
}
