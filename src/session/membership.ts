import { ADMITTED_PARTICIPANTS, CONTROL_ENTRIES, EXPIRY_MS } from '../network/limits';
import { check, id } from '../game/validation';

/**
 * Transient logical membership. Room membership, entry order, tenure and priority are
 * session state: they never enter durable game history, backups or workspace snapshots.
 * Identity hints are labels, not authentication — the local participant id is whatever the
 * caller passes in.
 */

export type Member = { id: string; order: number };
export type Tenure = { id: string; term: number; leaderId: string };
export type MembershipView = { members: Member[]; tenure: Tenure | null; ambiguous: boolean };

/**
 * Control events exchanged between participants.
 *
 * - `admission-request` asks the active leader for a position.
 * - `admission-grant` records one logical position. It names the granting leader and the
 *   leader's own position so a receiver can rebuild the roster from grants alone.
 * - `leave` retires a position; a later rejoin is a new admission, never the old one.
 * - `tenure-transition` records a leadership handover and the term it starts.
 */
export type MembershipEvent =
  | { type: 'admission-request'; id: string; requesterId: string; at: number }
  | { type: 'admission-grant'; id: string; participantId: string; order: number; grantorId: string; grantorOrder: number; term: number }
  | { type: 'leave'; id: string; participantId: string; at: number }
  | { type: 'tenure-transition'; id: string; term: number; leaderId: string; previousLeaderId: string };

export type MembershipOptions = {
  localId: string;
  founder: boolean;
  now: () => number;
  id: () => string;
  publish: (event: MembershipEvent) => void;
};

export type Membership = {
  observe(events: readonly MembershipEvent[], presence: readonly { id: string; seenAt: number }[]): void;
  tick(): void;
  getView(): MembershipView;
  subscribe(fn: () => void): () => void;
  leave(): void;
  destroy(): void;
};

type Grant = Extract<MembershipEvent, { type: 'admission-grant' }>;
type Candidate = { leaderId: string; term: number };

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A tenure id is derived from the room, not from the local participant, so every participant
 * computes the same identifier for the same leadership term.
 */
const tenureId = (term: number, leaderId: string) => `tenure-${term}-${leaderId}`;

/** Validates one event, returning a normalized copy or `null` for anything malformed. */
export function validateMembershipEvent(value: unknown): MembershipEvent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case 'admission-request': {
      if (Object.keys(event).some(key => !['type', 'id', 'requesterId', 'at'].includes(key))) return null;
      if (typeof event.id !== 'string' || !event.id) return null;
      if (typeof event.requesterId !== 'string' || !event.requesterId) return null;
      if (typeof event.at !== 'number' || !Number.isFinite(event.at)) return null;
      return { type: 'admission-request', id: event.id, requesterId: event.requesterId, at: event.at };
    }
    case 'admission-grant': {
      if (Object.keys(event).some(key => !['type', 'id', 'participantId', 'order', 'grantorId', 'grantorOrder', 'term'].includes(key))) return null;
      if (typeof event.id !== 'string' || !event.id) return null;
      if (typeof event.participantId !== 'string' || !event.participantId) return null;
      if (typeof event.grantorId !== 'string' || !event.grantorId) return null;
      if (!Number.isSafeInteger(event.order) || (event.order as number) < 0) return null;
      if (!Number.isSafeInteger(event.grantorOrder) || (event.grantorOrder as number) < 0) return null;
      if (!Number.isSafeInteger(event.term) || (event.term as number) < 1) return null;
      return {
        type: 'admission-grant', id: event.id, participantId: event.participantId, order: event.order as number,
        grantorId: event.grantorId, grantorOrder: event.grantorOrder as number, term: event.term as number,
      };
    }
    case 'leave': {
      if (Object.keys(event).some(key => !['type', 'id', 'participantId', 'at'].includes(key))) return null;
      if (typeof event.id !== 'string' || !event.id) return null;
      if (typeof event.participantId !== 'string' || !event.participantId) return null;
      if (typeof event.at !== 'number' || !Number.isFinite(event.at)) return null;
      return { type: 'leave', id: event.id, participantId: event.participantId, at: event.at };
    }
    case 'tenure-transition': {
      if (Object.keys(event).some(key => !['type', 'id', 'term', 'leaderId', 'previousLeaderId'].includes(key))) return null;
      if (typeof event.id !== 'string' || !event.id) return null;
      if (typeof event.leaderId !== 'string' || !event.leaderId) return null;
      if (typeof event.previousLeaderId !== 'string' || !event.previousLeaderId) return null;
      if (!Number.isSafeInteger(event.term) || (event.term as number) < 1) return null;
      return { type: 'tenure-transition', id: event.id, term: event.term as number, leaderId: event.leaderId, previousLeaderId: event.previousLeaderId };
    }
    default: return null;
  }
}

/**
 * Tracks the transient logical room roster.
 *
 * Entry order is logical, never wall-clock based: the founder holds order 0 and every later
 * admission is granted the next order by the active leader. Expiry uses only locally observed
 * presence plus the grace period — a remote timestamp is display data, not proof of liveness.
 * A tenure transition increments the term; competing same-term candidates converge on the
 * previously admitted order, then the participant id, and flag the view as ambiguous.
 *
 * The roster is derived from a bounded log of accepted grants, so the view does not depend on
 * the order the control events were delivered in.
 */
export function createMembership(options: MembershipOptions): Membership {
  const localId = id(options.localId);
  const now = options.now;
  const nextId = options.id;
  const publish = options.publish;

  const listeners = new Set<() => void>();
  /** Accepted grants, in acceptance order. The roster is projected from this log. */
  const grants: Grant[] = [];
  /** Grants that arrived before the room was established and could not be applied yet. */
  const pending: Grant[] = [];
  const requests = new Map<string, number>();
  const seenEvents = new Set<string>();
  const candidates = new Map<string, Candidate>();
  const retired = new Set<string>();
  /** Last locally observed presence time per participant. */
  const reachable = new Map<string, number>();

  let tenure: Tenure | null = null;
  let ambiguous = false;
  let destroyed = false;

  const notify = () => { for (const fn of [...listeners]) fn(); };
  /** Keeps a control log within the shared entry budget by dropping its oldest entry. */
  const trim = (log: Grant[]) => { while (log.length > CONTROL_ENTRIES) log.shift(); };

  if (options.founder) {
    tenure = { id: tenureId(1, localId), term: 1, leaderId: localId };
    reachable.set(localId, now());
  }

  /**
   * Projects the roster from the accepted grants. A grant records the position of the new
   * member and of the granting leader; a member that left and rejoins holds a new position
   * rather than the old one.
   */
  const roster = () => {
    const positions = new Map<string, number>();
    for (const grant of grants) {
      if (!positions.has(grant.grantorId)) positions.set(grant.grantorId, grant.grantorOrder);
      positions.set(grant.participantId, grant.order);
    }
    if (tenure && options.founder && !positions.has(localId)) positions.set(localId, 0);
    return [...positions.entries()]
      .filter(([participantId]) => !retired.has(participantId))
      .map(([participantId, order]) => ({ id: participantId, order }))
      .sort((a, b) => a.order - b.order || byId(a.id, b.id));
  };
  const orderOf = (participantId: string) => roster().find(member => member.id === participantId)?.order;
  const maxOrder = () => roster().reduce((max, member) => Math.max(max, member.order), -1);

  /** Whether a participant was heard from recently enough to still count as reachable. */
  const isReachable = (participantId: string) => {
    const last = reachable.get(participantId);
    return last !== undefined && now() - last <= EXPIRY_MS;
  };

  /** The successor is the least ordered admitted member that is still locally reachable. */
  const successor = () => {
    for (const member of roster()) {
      if (member.id === tenure?.leaderId) continue;
      if (!isReachable(member.id)) continue;
      return member.id;
    }
    return undefined;
  };

  /**
   * Drops members whose locally observed presence expired past the grace period. A member that
   * is unreachable but still within the grace period keeps its position, so a transient
   * interruption does not create a new admission.
   */
  const expireUnreachable = () => {
    const at = now();
    let changed = false;
    for (const member of roster()) {
      const last = reachable.get(member.id);
      if (last === undefined) continue;
      if (at - last <= EXPIRY_MS) continue;
      retired.add(member.id);
      changed = true;
    }
    return changed;
  };

  /**
   * Sets the leadership term. The tenure identifier is derived from the term and its leader so
   * every participant computes the same identifier for the same tenure.
   */
  const setTenure = (term: number, leaderId: string) => {
    tenure = { id: tenureId(term, leaderId), term, leaderId };
  };

  /** Records a leader candidate for a term; same-term rivals are resolved deterministically. */
  const propose = (leaderId: string, term: number) => {
    if (!tenure || term < tenure.term) return;
    if (term > tenure.term) {
      // A later term supersedes every earlier candidate.
      candidates.clear();
      setTenure(term, tenure.leaderId);
      ambiguous = false;
    }
    const current = candidates.get(leaderId);
    if (current && current.term === term) return;
    // The sitting leader is a candidate too, so a rival is resolved against it.
    candidates.set(leaderId, { leaderId, term });
    if (tenure.term === term) candidates.set(tenure.leaderId, { leaderId: tenure.leaderId, term });
    resolveCandidates(term);
  };

  /** Competing same-term candidates converge by previous admitted order, then participant id. */
  const resolveCandidates = (term: number) => {
    const rivals = [...candidates.values()].filter(candidate => candidate.term === term);
    if (!rivals.length) return;
    if (rivals.length > 1) {
      ambiguous = true;
      rivals.sort((a, b) => {
        const orderA = orderOf(a.leaderId) ?? Number.MAX_SAFE_INTEGER;
        const orderB = orderOf(b.leaderId) ?? Number.MAX_SAFE_INTEGER;
        return orderA - orderB || byId(a.leaderId, b.leaderId);
      });
    }
    const winner = rivals[0];
    if (tenure && tenure.term === term && tenure.leaderId !== winner.leaderId) {
      setTenure(term, winner.leaderId);
    }
  };

  /** Grants admission for a requester using the active leader's next logical order. */
  const grant = (requesterId: string) => {
    if (!tenure) return;
    if (roster().some(member => member.id === requesterId)) return;
    if (roster().length >= ADMITTED_PARTICIPANTS) return;
    const grantorOrder = orderOf(tenure.leaderId);
    if (grantorOrder === undefined) return;
    const event: Grant = {
      type: 'admission-grant', id: nextId(), participantId: requesterId,
      order: maxOrder() + 1, grantorId: tenure.leaderId, grantorOrder, term: tenure.term,
    };
    publish(event);
    acceptGrant(event);
  };

  const acceptGrant = (grant: Grant) => {
    if (!tenure) {
      // The first grant observed establishes the room: the grantor opened it and holds position 0.
      // A grant that does not concern the local participant cannot establish a room, but it is
      // kept: once the room is known it is applied like any other grant.
      if (grant.participantId !== localId) { pending.push(grant); trim(pending); return; }
      setTenure(grant.term, grant.grantorId);
    } else if (grant.term < tenure.term) {
      // A grant naming a stale term is rejected outright.
      return;
    } else if (grant.grantorId !== tenure.leaderId && grant.term === tenure.term) {
      // A grant from a rival leader of the same term contests the leadership. The admission is
      // still a fact, so it is recorded; only the leadership claim is left to the candidates.
      propose(grant.grantorId, grant.term);
    }
    grants.push(grant);
    trim(grants);
    retired.delete(grant.participantId);
    if (grant.term > (tenure?.term ?? 0)) {
      setTenure(grant.term, grant.grantorId);
      candidates.clear();
      ambiguous = false;
    }
  };

  /** Applies the grants that were held back until the room was established. */
  const drainPending = () => {
    if (!tenure || !pending.length) return;
    const held = pending.splice(0, pending.length);
    for (const grant of held) acceptGrant(grant);
  };

  /** Hands leadership to the least ordered reachable admitted member. */
  const succeed = () => {
    if (!tenure) return;
    if (isReachable(tenure.leaderId)) return;
    const next = successor();
    if (!next) return;
    const previousLeaderId = tenure.leaderId;
    const term = tenure.term + 1;
    setTenure(term, next);
    candidates.clear();
    ambiguous = false;
    publish({ type: 'tenure-transition', id: tenureId(term, next), term, leaderId: next, previousLeaderId });
  };

  const controller: Membership = {
    observe(events, presence) {
      check(!destroyed, 'Membership is closed.');
      let changed = false;
      for (const entry of presence) {
        if (typeof entry?.id !== 'string' || !entry.id) continue;
        if (typeof entry.seenAt !== 'number' || !Number.isFinite(entry.seenAt)) continue;
        const previous = reachable.get(entry.id);
        if (previous === undefined || entry.seenAt > previous) { reachable.set(entry.id, entry.seenAt); changed = true; }
      }
      for (const raw of events) {
        const event = validateMembershipEvent(raw);
        if (!event) continue;
        if (seenEvents.has(event.id)) continue;
        seenEvents.add(event.id);
        if (seenEvents.size > CONTROL_ENTRIES) {
          // Keep the bounded control view bounded; the oldest bookkeeping entry is dropped.
          const oldest = seenEvents.values().next().value as string | undefined;
          if (oldest !== undefined) seenEvents.delete(oldest);
        }
        switch (event.type) {
          case 'admission-request': {
            // Requests are remembered only to bound them; the grant is the membership fact.
            requests.set(event.requesterId, event.at);
            if (requests.size > CONTROL_ENTRIES) {
              const oldest = requests.keys().next().value as string | undefined;
              if (oldest !== undefined) requests.delete(oldest);
            }
            // Only the active leader answers admission requests.
            if (tenure && tenure.leaderId === localId) grant(event.requesterId);
            break;
          }
          case 'admission-grant': acceptGrant(event); changed = true; break;
          case 'leave': {
            if (retired.has(event.participantId)) break;
            retired.add(event.participantId);
            reachable.delete(event.participantId);
            changed = true;
            break;
          }
          case 'tenure-transition': {
            if (!tenure) break;
            if (event.term < tenure.term) break;
            if (event.term === tenure.term && tenure.leaderId !== event.leaderId) {
              // Same-term rivals: converge deterministically rather than trusting delivery order.
              propose(event.leaderId, event.term);
              changed = true;
              break;
            }
            if (event.term > tenure.term) {
              setTenure(event.term, event.leaderId);
              candidates.clear();
              ambiguous = false;
            }
            changed = true;
            break;
          }
        }
      }
      drainPending();
      if (changed) notify();
    },
    tick() {
      check(!destroyed, 'Membership is closed.');
      const before = JSON.stringify({ members: roster(), tenure, ambiguous });
      const expired = expireUnreachable();
      succeed();
      const after = JSON.stringify({ members: roster(), tenure, ambiguous });
      if (expired || before !== after) notify();
    },
    getView(): MembershipView {
      return { members: roster(), tenure: tenure ? { ...tenure } : null, ambiguous };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    leave() {
      if (destroyed) return;
      publish({ type: 'leave', id: nextId(), participantId: localId, at: now() });
      retired.add(localId);
      reachable.delete(localId);
      notify();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
      grants.length = 0;
      requests.clear();
      candidates.clear();
      seenEvents.clear();
      reachable.clear();
      retired.clear();
    },
  };
  return controller;
}
