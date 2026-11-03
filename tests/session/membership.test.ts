import { describe, expect, it } from 'vitest';
import { createMembership, type MembershipEvent } from '../../src/session/membership';
import { ADMITTED_PARTICIPANTS, CONTROL_ENTRIES, EXPIRY_MS } from '../../src/network/limits';
import { createWorkspace } from '../../src/game/workspace';
import { createTestWorkspace, namedRuntime } from '../helpers/workspace';

type Clock = { at: number; now: () => number; advance: (ms: number) => void };

function clock(start = 1_000): Clock {
  let at = start;
  return { at, now: () => at, advance: (ms: number) => { at += ms; } };
}

/** A participant with a deterministic identity generator and a published-event log. */
function peer(label: string, opts: { founder?: boolean; clock?: Clock } = {}) {
  const time = opts.clock ?? clock();
  const published: MembershipEvent[] = [];
  let counter = 0;
  const membership = createMembership({
    localId: label,
    founder: opts.founder ?? false,
    now: time.now,
    id: () => `${label}-${++counter}`,
    publish: event => { published.push(event); },
  });
  return { label, membership, published, clock: time };
}

/**
 * Presence list in the observing peer's clock domain: `seenAt` is a local timestamp of the
 * last time this client heard from the participant, exactly as the room transport reports it.
 */
function presence(observer: { clock: Clock }, ...ids: string[]) {
  return ids.map(id => ({ id, seenAt: observer.clock.now() }));
}

/** The grant a leader published for one participant. */
function grantFor(published: readonly MembershipEvent[], participantId: string) {
  const grant = published.find(event => event.type === 'admission-grant' && event.participantId === participantId);
  if (!grant || grant.type !== 'admission-grant') throw new Error(`No grant for ${participantId}.`);
  return grant;
}

/** The leave a participant published for itself. */
function leaveOf(published: readonly MembershipEvent[]) {
  const leave = published.find(event => event.type === 'leave');
  if (!leave) throw new Error('No leave event.');
  return leave;
}

/** The tenure transition a participant published. */
function transitionOf(published: readonly MembershipEvent[]) {
  const transition = published.find(event => event.type === 'tenure-transition');
  if (!transition) throw new Error('No tenure transition.');
  return transition;
}

describe('transient logical membership', () => {
  it('admits members in logical order despite skewed remote timestamps', () => {
    const alice = peer('alice', { founder: true });
    const bob = peer('bob');
    const carol = peer('carol');

    alice.membership.observe([{ type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 9_000_000 }], presence(alice, 'bob'));
    alice.membership.observe([{ type: 'admission-request', id: 'r-carol', requesterId: 'carol', at: 1 }], presence(alice, 'carol'));
    const bobGrant = grantFor(alice.published, 'bob');
    const carolGrant = grantFor(alice.published, 'carol');
    expect(bobGrant.order).toBe(1);
    expect(carolGrant.order).toBe(2);

    bob.membership.observe([bobGrant], presence(bob, 'bob', 'alice'));
    carol.membership.observe([bobGrant, carolGrant], presence(carol, 'carol', 'alice', 'bob'));
    alice.membership.observe([bobGrant, carolGrant], presence(alice, 'alice', 'bob', 'carol'));

    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob', 'carol']);
    expect(alice.membership.getView().members.map(m => m.order)).toEqual([0, 1, 2]);
    expect(bob.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob']);
    expect(carol.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob', 'carol']);
  });

  it('expires founder and elects next admitted member', () => {
    const alice = peer('alice', { founder: true });
    const bob = peer('bob');
    alice.membership.observe([{ type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 0 }], presence(alice, 'bob'));
    const grant = grantFor(alice.published, 'bob');
    bob.membership.observe([grant], presence(bob, 'bob', 'alice'));
    alice.membership.observe([grant], presence(alice, 'alice', 'bob'));
    expect(alice.membership.getView().tenure!.leaderId).toBe('alice');
    expect(alice.membership.getView().tenure!.term).toBe(1);

    alice.clock.advance(EXPIRY_MS + 1);
    alice.membership.observe([], presence(alice, 'bob'));
    alice.membership.tick();

    const view = alice.membership.getView();
    expect(view.tenure!.leaderId).toBe('bob');
    expect(view.tenure!.term).toBe(2);
    expect(view.members.map(m => m.id)).toEqual(['bob']);
  });

  it('rejoin loses prior rank', () => {
    const alice = peer('alice', { founder: true });
    alice.membership.observe([
      { type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 0 },
      { type: 'admission-request', id: 'r-carol', requesterId: 'carol', at: 0 },
    ], presence(alice, 'bob', 'carol'));
    const bobGrant = grantFor(alice.published, 'bob');
    const carolGrant = grantFor(alice.published, 'carol');
    alice.membership.observe([bobGrant, carolGrant], presence(alice, 'alice', 'bob', 'carol'));
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob', 'carol']);

    // Alice leaves; a rejoining identity is a new admission at the end of the logical order.
    alice.membership.leave();
    const departure = leaveOf(alice.published);
    const aliceNew = peer('alice-new');
    aliceNew.membership.observe([{ type: 'admission-request', id: 'r-alice-new', requesterId: 'alice-new', at: 0 }], presence(aliceNew, 'alice-new'));
    expect(aliceNew.published.some(e => e.type === 'admission-grant')).toBe(false);

    // The rejoining identity replays the room's control log and is admitted at the next order.
    const rejoin: MembershipEvent = {
      type: 'admission-grant', id: 'g-rejoin', participantId: 'alice-new',
      order: 3, grantorId: 'alice', grantorOrder: 0, term: 1,
    };
    aliceNew.membership.observe([bobGrant, carolGrant, departure, rejoin], presence(aliceNew, 'alice-new', 'bob', 'carol'));
    expect(aliceNew.membership.getView().members.map(m => m.id)).toEqual(['bob', 'carol', 'alice-new']);
    expect(aliceNew.membership.getView().members.map(m => m.order)).toEqual([1, 2, 3]);
  });

  it('rejoins under the same identity without restoring the old position', () => {
    const alice = peer('alice', { founder: true });
    const bob = peer('bob');
    alice.membership.observe([{ type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 0 }], presence(alice, 'bob'));
    const bobGrant = grantFor(alice.published, 'bob');
    alice.membership.observe([bobGrant], presence(alice, 'alice', 'bob'));
    bob.membership.observe([bobGrant], presence(bob, 'bob', 'alice'));
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob']);

    // Alice leaves; Bob succeeds and admits the same identity again at the end of the order.
    alice.membership.leave();
    const departure = leaveOf(alice.published);
    alice.membership.observe([bobGrant, departure], presence(alice, 'bob'));
    bob.membership.observe([bobGrant, departure], presence(bob, 'bob'));
    bob.clock.advance(EXPIRY_MS + 1);
    bob.membership.observe([], presence(bob, 'bob'));
    bob.membership.tick();
    const handover = transitionOf(bob.published);
    expect(handover).toMatchObject({ term: 2, leaderId: 'bob', previousLeaderId: 'alice' });
    alice.membership.observe([handover], presence(alice, 'bob'));
    expect(alice.membership.getView().tenure!.leaderId).toBe('bob');
    expect(alice.membership.getView().tenure!.term).toBe(2);

    const rejoin: MembershipEvent = {
      type: 'admission-grant', id: 'g-rejoin', participantId: 'alice',
      order: 2, grantorId: 'bob', grantorOrder: 1, term: 2,
    };
    alice.membership.observe([rejoin], presence(alice, 'alice', 'bob'));
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['bob', 'alice']);
    expect(alice.membership.getView().members.map(m => m.order)).toEqual([1, 2]);
  });

  it('converges equal-term split candidates in both delivery orders', () => {
    const build = (reverse: boolean) => {
      const left = peer('left', { founder: true });
      const right = peer('right', { founder: true });
      const carol = peer('carol');
      left.membership.observe([{ type: 'admission-request', id: 'r-carol', requesterId: 'carol', at: 0 }], presence(left, 'carol'));
      right.membership.observe([{ type: 'admission-request', id: 'r-carol', requesterId: 'carol', at: 0 }], presence(right, 'carol'));
      const leftGrant = grantFor(left.published, 'carol');
      const rightGrant = grantFor(right.published, 'carol');
      const events = reverse ? [rightGrant, leftGrant] : [leftGrant, rightGrant];
      left.membership.observe(events, presence(left, 'carol'));
      right.membership.observe(events, presence(right, 'carol'));
      carol.membership.observe(events, presence(carol, 'carol', 'left', 'right'));
      return { left, right };
    };
    const a = build(false);
    const b = build(true);
    expect(a.left.membership.getView()).toEqual(b.left.membership.getView());
    expect(a.left.membership.getView().ambiguous).toBe(true);
    expect(a.left.membership.getView().tenure!.leaderId).toBe('left');
  });

  it('converges split candidates that granted different positions', () => {
    // Two branches admitted Carol at different positions; the admitted order breaks the tie.
    const build = (reverse: boolean) => {
      const left = peer('left', { founder: true });
      const right = peer('right', { founder: true });
      const carol = peer('carol');
      const dave = peer('dave');
      left.membership.observe([{ type: 'admission-request', id: 'r-carol', requesterId: 'carol', at: 0 }], presence(left, 'carol'));
      right.membership.observe([{ type: 'admission-request', id: 'r-dave', requesterId: 'dave', at: 0 }], presence(right, 'dave'));
      const leftGrant = grantFor(left.published, 'carol');
      const rightGrant = grantFor(right.published, 'dave');
      const events = reverse ? [rightGrant, leftGrant] : [leftGrant, rightGrant];
      for (const peer of [left, right, carol, dave]) peer.membership.observe(events, presence(peer, 'carol', 'dave', 'left', 'right'));
      return { left, right };
    };
    const a = build(false);
    const b = build(true);
    expect(a.left.membership.getView()).toEqual(b.left.membership.getView());
    expect(a.left.membership.getView().ambiguous).toBe(true);
    // The lower admitted position wins the contested leadership.
    expect(a.left.membership.getView().tenure!.leaderId).toBe('left');
  });

  it('supplies no membership from a reloaded game snapshot', () => {
    // A durable game is written, snapshotted and restored; the restored copy must not carry
    // any membership, order or tenure into the session layer.
    const source = createTestWorkspace('alice');
    source.applyLocal({ type: 'set-game-name', name: 'Restored Castle' });
    const snapshot = source.getSnapshot();
    const restored = createWorkspace(snapshot, namedRuntime('restored'), 'restored');
    expect(restored.getSnapshot().game.name).toBe('Restored Castle');

    const membership = peer('restored');
    expect(membership.membership.getView().members).toEqual([]);
    expect(membership.membership.getView().tenure).toBeNull();
    expect(membership.membership.getView().ambiguous).toBe(false);

    // Restoring the same snapshot again still supplies no membership.
    const again = createWorkspace(snapshot, namedRuntime('restored-again'), 'restored-again');
    expect(again.getSnapshot().game.name).toBe('Restored Castle');
    expect(membership.membership.getView().members).toEqual([]);
    expect(membership.membership.getView().tenure).toBeNull();
  });

  it('supplies no membership when a room with history is restored', () => {
    // The durable side records real gameplay and the session side records a real room; only
    // the gameplay survives the snapshot.
    const source = createTestWorkspace('alice');
    source.applyLocal({ type: 'set-game-name', name: 'Old Castle' });
    source.applyLocal({ type: 'roll', playerId: 'alex', sides: 20 });

    const alice = peer('alice', { founder: true });
    const bob = peer('bob');
    alice.membership.observe([{ type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 0 }], presence(alice, 'bob'));
    const bobGrant = grantFor(alice.published, 'bob');
    alice.membership.observe([bobGrant], presence(alice, 'alice', 'bob'));
    bob.membership.observe([bobGrant], presence(bob, 'bob', 'alice'));
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob']);
    expect(alice.membership.getView().tenure!.leaderId).toBe('alice');

    const snapshot = source.getSnapshot();
    const restored = createWorkspace(snapshot, namedRuntime('restored'), 'restored');
    expect(restored.getSnapshot().game.name).toBe('Old Castle');
    expect(restored.getSnapshot().game.rolls).toHaveLength(1);

    // The restored copy carries the gameplay and none of the room state.
    const reopened = peer('reopened');
    expect(reopened.membership.getView().members).toEqual([]);
    expect(reopened.membership.getView().tenure).toBeNull();
    expect(reopened.membership.getView().ambiguous).toBe(false);
  });

  it('rejects stale-term control requests', () => {
    const alice = peer('alice', { founder: true });
    const bob = peer('bob');
    alice.membership.observe([{ type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 0 }], presence(alice, 'bob'));
    const grant = grantFor(alice.published, 'bob');
    bob.membership.observe([grant], presence(bob, 'bob', 'alice'));
    // A grant naming an older term than the receiver's current tenure is ignored.
    const stale: MembershipEvent = {
      type: 'admission-grant', id: 'g-stale', participantId: 'mallory',
      order: 5, grantorId: 'alice', grantorOrder: 0, term: 0,
    };
    bob.membership.observe([stale], presence(bob, 'bob', 'alice'));
    expect(bob.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob']);
  });

  it('ignores grants from unknown grantors and bounds a flood of requests', () => {
    const alice = peer('alice', { founder: true });
    const flood = Array.from({ length: 300 }, (_, n) => ({ type: 'admission-request' as const, id: `r-${n}`, requesterId: `p${n}`, at: 0 }));
    alice.membership.observe(flood, presence(alice));
    const grants = alice.published.filter(event => event.type === 'admission-grant');
    expect(grants.length).toBeLessThanOrEqual(32);
    // The room stays consistent: one leader, one ordered roster, no ambiguity.
    expect(alice.membership.getView().tenure!.leaderId).toBe('alice');
    expect(alice.membership.getView().ambiguous).toBe(false);
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice', ...grants.map(g => g.participantId)]);

    const stranger = peer('stranger');
    stranger.membership.observe([{ type: 'admission-grant', id: 'g-1', participantId: 'mallory', order: 3, grantorId: 'ghost', grantorOrder: 0, term: 1 }], presence(stranger));
    expect(stranger.membership.getView().members).toEqual([]);
    expect(stranger.membership.getView().tenure).toBeNull();
  });

  it('converges after a partition heals', () => {
    const alice = peer('alice', { founder: true });
    const bob = peer('bob');
    alice.membership.observe([{ type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 0 }], presence(alice, 'bob'));
    const bobGrant = grantFor(alice.published, 'bob');

    // The room splits: Alice hears Bob, Bob does not hear Alice.
    alice.membership.observe([bobGrant], presence(alice, 'alice', 'bob'));
    bob.membership.observe([bobGrant], presence(bob, 'bob'));
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob']);
    expect(bob.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob']);
    // Only the presence differs while the room is split.
    expect(bob.membership.getView().tenure!.leaderId).toBe('alice');

    // Healing exchanges the rest of the control log; both sides agree afterwards.
    const carol = peer('carol');
    alice.membership.observe([{ type: 'admission-request', id: 'r-carol', requesterId: 'carol', at: 0 }], presence(alice, 'alice', 'bob', 'carol'));
    const carolGrant = grantFor(alice.published, 'carol');
    bob.membership.observe([carolGrant], presence(bob, 'bob', 'alice', 'carol'));
    carol.membership.observe([bobGrant, carolGrant], presence(carol, 'carol', 'alice', 'bob'));
    expect(bob.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob', 'carol']);
    expect(carol.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob', 'carol']);
    expect(alice.membership.getView()).toEqual(bob.membership.getView());
    expect(bob.membership.getView()).toEqual(carol.membership.getView());
  });

  it('emits exactly one tenure transition per handover', () => {
    const alice = peer('alice', { founder: true });
    const bob = peer('bob');
    alice.membership.observe([{ type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 0 }], presence(alice, 'bob'));
    const grant = grantFor(alice.published, 'bob');
    bob.membership.observe([grant], presence(bob, 'bob', 'alice'));
    alice.membership.observe([grant], presence(alice, 'alice', 'bob'));

    alice.clock.advance(EXPIRY_MS + 1);
    alice.membership.observe([], presence(alice, 'bob'));
    alice.membership.tick();
    alice.membership.tick();
    const transitions = alice.published.filter(event => event.type === 'tenure-transition');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ term: 2, leaderId: 'bob', previousLeaderId: 'alice' });
  });

  it('converges after asymmetric delivery', () => {
    const alice = peer('alice', { founder: true });
    const bob = peer('bob');
    alice.membership.observe([{ type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 0 }], presence(alice, 'bob'));
    const grant = grantFor(alice.published, 'bob');
    // Alice sees Bob first; Bob only learns later.
    alice.membership.observe([grant], presence(alice, 'alice', 'bob'));
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob']);
    bob.membership.observe([grant], presence(bob, 'bob', 'alice'));
    expect(bob.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob']);
    expect(alice.membership.getView()).toEqual(bob.membership.getView());
  });

  it('elects the next successor when the successor is lost', () => {
    const alice = peer('alice', { founder: true });
    const bob = peer('bob');
    const carol = peer('carol');
    alice.membership.observe([
      { type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 0 },
      { type: 'admission-request', id: 'r-carol', requesterId: 'carol', at: 0 },
    ], presence(alice, 'bob', 'carol'));
    const bobGrant = grantFor(alice.published, 'bob');
    const carolGrant = grantFor(alice.published, 'carol');
    alice.membership.observe([bobGrant, carolGrant], presence(alice, 'alice', 'bob', 'carol'));
    bob.membership.observe([bobGrant, carolGrant], presence(bob, 'bob', 'alice', 'carol'));
    carol.membership.observe([bobGrant, carolGrant], presence(carol, 'carol', 'alice', 'bob'));

    alice.clock.advance(EXPIRY_MS + 1);
    alice.membership.observe([], presence(alice, 'bob', 'carol'));
    alice.membership.tick();
    expect(alice.membership.getView().tenure!.leaderId).toBe('bob');
    expect(alice.membership.getView().tenure!.term).toBe(2);
    const handover = transitionOf(alice.published);
    bob.membership.observe([handover], presence(bob, 'bob', 'carol'));
    expect(bob.membership.getView().tenure!.leaderId).toBe('bob');
    expect(bob.membership.getView().tenure!.term).toBe(2);

    // Bob takes over from Alice and then loses its own reachability: Carol succeeds.
    bob.clock.advance(EXPIRY_MS + 1);
    bob.membership.observe([], presence(bob, 'carol'));
    bob.membership.tick();
    expect(bob.membership.getView().tenure!.leaderId).toBe('carol');
    expect(bob.membership.getView().tenure!.term).toBe(3);
    expect(bob.membership.getView().tenure!.id).toBe('tenure-3-carol');
  });

  it('keeps a transiently unreachable member within the grace period', () => {
    const alice = peer('alice', { founder: true });
    const bob = peer('bob');
    alice.membership.observe([{ type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 0 }], presence(alice, 'bob'));
    const grant = grantFor(alice.published, 'bob');
    alice.membership.observe([grant], presence(alice, 'alice', 'bob'));
    bob.membership.observe([grant], presence(bob, 'bob', 'alice'));

    alice.clock.advance(EXPIRY_MS - 1);
    alice.membership.observe([], presence(alice));
    alice.membership.tick();
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob']);
    expect(alice.membership.getView().tenure!.leaderId).toBe('alice');
  });

  it('records an explicit leave without electing a new leader while the leader remains', () => {
    const alice = peer('alice', { founder: true });
    const bob = peer('bob');
    alice.membership.observe([{ type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 0 }], presence(alice, 'bob'));
    const grant = grantFor(alice.published, 'bob');
    alice.membership.observe([grant], presence(alice, 'alice', 'bob'));
    bob.membership.observe([grant], presence(bob, 'bob', 'alice'));

    bob.membership.leave();
    expect(bob.published.some(e => e.type === 'leave')).toBe(true);
    alice.membership.observe([leaveOf(bob.published)], presence(alice, 'alice', 'bob'));
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice']);
    expect(alice.membership.getView().tenure!.leaderId).toBe('alice');
  });

  it('does not mutate durable game history', () => {
    // A real workspace stands in for the durable side: membership must never touch it.
    const workspace = createTestWorkspace('alice');
    const before = JSON.stringify(workspace.getHistory());
    const alice = peer('alice', { founder: true });
    const bob = peer('bob');
    alice.membership.observe([{ type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 0 }], presence(alice, 'bob'));
    const grant = grantFor(alice.published, 'bob');
    bob.membership.observe([grant], presence(bob, 'bob', 'alice'));
    alice.membership.observe([grant], presence(alice, 'alice', 'bob'));
    alice.clock.advance(EXPIRY_MS + 1);
    alice.membership.observe([], presence(alice, 'bob'));
    alice.membership.tick();
    alice.membership.leave();
    alice.membership.destroy();
    expect(JSON.stringify(workspace.getHistory())).toBe(before);
    expect(workspace.getSnapshot().history.byteLength).toBeGreaterThan(0);
  });

  it('notifies subscribers and stops after destroy', () => {
    const alice = peer('alice', { founder: true });
    let calls = 0;
    const off = alice.membership.subscribe(() => { calls++; });
    alice.membership.observe([{ type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 0 }], presence(alice, 'bob'));
    expect(calls).toBeGreaterThan(0);
    off();
    const seen = calls;
    alice.membership.observe([], presence(alice));
    expect(calls).toBe(seen);
    alice.membership.destroy();
  });

  it('checkpoints the control view so churn does not lose admitted members', () => {
    const alice = peer('alice', { founder: true });
    const bob = peer('bob');
    // Bob is admitted and stays in the room for the whole churn.
    alice.membership.observe([{ type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 0 }], presence(alice, 'bob'));
    const bobGrant = grantFor(alice.published, 'bob');
    alice.membership.observe([bobGrant], presence(alice, 'alice', 'bob'));
    bob.membership.observe([bobGrant], presence(bob, 'bob', 'alice'));
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob']);

    // Churn: more grants and leaves than the control view can hold, while the admitted
    // membership stays within the participant bound.
    for (let n = 0; n < CONTROL_ENTRIES + 40; n++) {
      const joiner = `p${n}`;
      alice.membership.observe([{ type: 'admission-request', id: `r-${joiner}`, requesterId: joiner, at: 0 }], presence(alice, 'alice', 'bob'));
      alice.membership.observe([], presence(alice, 'alice', 'bob'));
      alice.membership.tick();
      const grant = alice.published.find(event => event.type === 'admission-grant' && event.participantId === joiner);
      if (!grant) continue;
      alice.membership.observe([{ type: 'leave', id: `l-${joiner}`, participantId: joiner, at: 0 }], presence(alice, 'alice', 'bob'));
      alice.membership.tick();
    }

    const view = alice.membership.getView();
    // The churned participants are gone, but the two real members and the tenure survive.
    expect(view.members.map(m => m.id)).toEqual(['alice', 'bob']);
    expect(view.members.map(m => m.order)).toEqual([0, 1]);
    expect(view.tenure!.leaderId).toBe('alice');
    expect(view.tenure!.term).toBe(1);
    expect(view.members.length).toBeLessThanOrEqual(ADMITTED_PARTICIPANTS);
  });

  it('checkpoints the control view without restoring a rejoined old position', () => {
    const alice = peer('alice', { founder: true });
    const bob = peer('bob');
    alice.membership.observe([{ type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 0 }], presence(alice, 'bob'));
    const bobGrant = grantFor(alice.published, 'bob');
    alice.membership.observe([bobGrant], presence(alice, 'alice', 'bob'));
    bob.membership.observe([bobGrant], presence(bob, 'bob', 'alice'));
    expect(alice.membership.getView().members.map(m => m.order)).toEqual([0, 1]);

    // Bob leaves and rejoins under a new identity at the end of the order.
    alice.membership.observe([{ type: 'leave', id: 'l-bob', participantId: 'bob', at: 0 }], presence(alice, 'alice'));
    const rejoin: MembershipEvent = {
      type: 'admission-grant', id: 'g-rejoin', participantId: 'bob-new',
      order: 2, grantorId: 'alice', grantorOrder: 0, term: 1,
    };
    alice.membership.observe([rejoin], presence(alice, 'alice', 'bob-new'));
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob-new']);
    expect(alice.membership.getView().members.map(m => m.order)).toEqual([0, 2]);

    // Churn past the control bound; the rejoined position must not fall back to the old one.
    for (let n = 0; n < CONTROL_ENTRIES + 40; n++) {
      const joiner = `p${n}`;
      alice.membership.observe([{ type: 'admission-request', id: `r-${joiner}`, requesterId: joiner, at: 0 }], presence(alice, 'alice', 'bob-new'));
      alice.membership.observe([], presence(alice, 'alice', 'bob-new'));
      alice.membership.tick();
      const grant = alice.published.find(event => event.type === 'admission-grant' && event.participantId === joiner);
      if (!grant) continue;
      alice.membership.observe([{ type: 'leave', id: `l-${joiner}`, participantId: joiner, at: 0 }], presence(alice, 'alice', 'bob-new'));
      alice.membership.tick();
    }

    const view = alice.membership.getView();
    expect(view.members.map(m => m.id)).toEqual(['alice', 'bob-new']);
    expect(view.members.map(m => m.order)).toEqual([0, 2]);
    expect(view.tenure!.leaderId).toBe('alice');
  });

  it('expires a member whose presence was never observed', () => {
    const alice = peer('alice', { founder: true });
    // Bob is admitted but Alice never hears from him: no presence is ever observed.
    alice.membership.observe([{ type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 0 }], presence(alice, 'alice'));
    const bobGrant = grantFor(alice.published, 'bob');
    alice.membership.observe([bobGrant], presence(alice, 'alice'));
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob']);

    // Within the grace period the unobserved member keeps its position.
    alice.clock.advance(EXPIRY_MS - 1);
    alice.membership.observe([], presence(alice, 'alice'));
    alice.membership.tick();
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob']);

    // Past the grace period the unobserved member is expired.
    alice.clock.advance(2);
    alice.membership.observe([], presence(alice, 'alice'));
    alice.membership.tick();
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice']);
    expect(alice.membership.getView().tenure!.leaderId).toBe('alice');
  });

  it('does not resurrect an expired member after control churn', () => {
    const alice = peer('alice', { founder: true });
    const bob = peer('bob');
    alice.membership.observe([{ type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 0 }], presence(alice, 'bob'));
    const bobGrant = grantFor(alice.published, 'bob');
    alice.membership.observe([bobGrant], presence(alice, 'alice', 'bob'));
    bob.membership.observe([bobGrant], presence(bob, 'bob', 'alice'));
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob']);

    // Bob's presence expires.
    alice.clock.advance(EXPIRY_MS + 1);
    alice.membership.observe([], presence(alice, 'alice'));
    alice.membership.tick();
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice']);

    // Churn past the control bound; the expired member must not come back from the checkpoint.
    for (let n = 0; n < CONTROL_ENTRIES + 40; n++) {
      const joiner = `p${n}`;
      alice.membership.observe([{ type: 'admission-request', id: `r-${joiner}`, requesterId: joiner, at: 0 }], presence(alice, 'alice'));
      alice.membership.observe([], presence(alice, 'alice'));
      alice.membership.tick();
      const grant = alice.published.find(event => event.type === 'admission-grant' && event.participantId === joiner);
      if (!grant) continue;
      alice.membership.observe([{ type: 'leave', id: `l-${joiner}`, participantId: joiner, at: 0 }], presence(alice, 'alice'));
      alice.membership.tick();
    }

    const view = alice.membership.getView();
    expect(view.members.map(m => m.id)).toEqual(['alice']);
    expect(view.tenure!.leaderId).toBe('alice');
  });

  it('releases the admission clock of a member that expires', () => {
    // Carol hears Alice's grant to Bob but never observes Alice's presence. Alice still holds a
    // position in Carol's roster, and that position must expire like any other.
    const alice = peer('alice', { founder: true });
    const carol = peer('carol');
    alice.membership.observe([{ type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 0 }], presence(alice, 'bob'));
    const bobGrant = grantFor(alice.published, 'bob');
    // Bob is granted a position too, so Carol's own grant establishes the room for her.
    const carolGrant: MembershipEvent = {
      type: 'admission-grant', id: 'g-carol', participantId: 'carol',
      order: 2, grantorId: 'alice', grantorOrder: 0, term: 1,
    };
    carol.membership.observe([bobGrant, carolGrant], presence(carol, 'carol'));
    expect(carol.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob', 'carol']);

    // Past the grace period Carol has heard from neither Alice nor Bob, so both expire.
    carol.clock.advance(EXPIRY_MS + 1);
    carol.membership.observe([], presence(carol, 'carol'));
    carol.membership.tick();
    expect(carol.membership.getView().members.map(m => m.id)).toEqual(['carol']);
  });

  it('gives a member re-admitted after expiry a fresh grace period', () => {
    const alice = peer('alice', { founder: true });
    const bob = peer('bob');
    alice.membership.observe([{ type: 'admission-request', id: 'r-bob', requesterId: 'bob', at: 0 }], presence(alice, 'alice'));
    const bobGrant = grantFor(alice.published, 'bob');
    alice.membership.observe([bobGrant], presence(alice, 'alice'));
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob']);

    // Bob is never observed, so his admission expires.
    alice.clock.advance(EXPIRY_MS + 1);
    alice.membership.observe([], presence(alice, 'alice'));
    alice.membership.tick();
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice']);

    // A re-admission starts a new grace period rather than inheriting the expired one.
    const rejoin: MembershipEvent = {
      type: 'admission-grant', id: 'g-rejoin', participantId: 'bob',
      order: 2, grantorId: 'alice', grantorOrder: 0, term: 1,
    };
    alice.membership.observe([rejoin], presence(alice, 'alice'));
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob']);
    alice.clock.advance(EXPIRY_MS - 1);
    alice.membership.observe([], presence(alice, 'alice'));
    alice.membership.tick();
    expect(alice.membership.getView().members.map(m => m.id)).toEqual(['alice', 'bob']);
  });

  it('bounds remote admissions at the participant limit and converges across delivery orders', () => {
    // A flood of remote grants from the same leader; the room keeps at most 32 admitted members.
    const build = (reverse: boolean) => {
      const alice = peer('alice', { founder: true });
      const carol = peer('carol');
      const grants: MembershipEvent[] = Array.from({ length: ADMITTED_PARTICIPANTS + 8 }, (_, n) => ({
        type: 'admission-grant', id: `g-${n}`, participantId: `p${n}`,
        order: n + 1, grantorId: 'alice', grantorOrder: 0, term: 1,
      }));
      // Carol is admitted by one of the grants, so her view covers the same room.
      grants.push({ type: 'admission-grant', id: 'g-carol', participantId: 'carol', order: 100, grantorId: 'alice', grantorOrder: 0, term: 1 });
      const events = reverse ? [...grants].reverse() : grants;
      for (const peer of [alice, carol]) peer.membership.observe(events, presence(peer, 'alice', 'carol'));
      return { alice, carol };
    };
    const a = build(false);
    const b = build(true);
    for (const view of [a.alice.membership.getView(), a.carol.membership.getView(), b.alice.membership.getView(), b.carol.membership.getView()]) {
      expect(view.members.length).toBeLessThanOrEqual(ADMITTED_PARTICIPANTS);
    }
    // Both delivery orders converge on the same bounded roster.
    expect(a.alice.membership.getView()).toEqual(b.alice.membership.getView());
    expect(a.carol.membership.getView()).toEqual(b.carol.membership.getView());
    expect(a.alice.membership.getView()).toEqual(a.carol.membership.getView());
    // The best-positioned members are the ones kept.
    expect(a.alice.membership.getView().members.map(m => m.id)).toEqual(
      ['alice', ...Array.from({ length: ADMITTED_PARTICIPANTS - 1 }, (_, n) => `p${n}`)],
    );
  });
});
