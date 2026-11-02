import { describe, expect, it } from 'vitest';
import { makeRosterAddition, projectHistory } from '../../src/game/history';
import { capturePriority, reconcileHistories } from '../../src/game/reconcile';
import type { GameHistory } from '../../src/game/sync-types';
import type { Player, Runtime } from '../../src/game/types';
import type { Workspace } from '../../src/game/workspace';
import { createTestWorkspace, fixtureRoster, forkTestWorkspace, namedRuntime } from '../helpers/workspace';

function castle() {
  const alice = createTestWorkspace('alice', { ...fixtureRoster(), name: 'Old Castle' });
  const bob = forkTestWorkspace(alice, 'bob'), carol = forkTestWorkspace(alice, 'carol');
  const priority = capturePriority(alice.getHistory(), alice.replicaId, 'tenure-1');
  return { alice, bob, carol, priority };
}
function addPlayer(w: Workspace, player: Player, label: string) {
  const op = makeRosterAddition(w.getHistory(), player, namedRuntime(label), w.replicaId);
  w.accept({ ...w.getHistory(), operations: { [op.id]: op } });
  return op;
}
function resolutions(history: GameHistory) { return Object.values(history.operations).filter(op => op.type === 'resolution'); }

describe('granular reconciliation', () => {
  it.each([false, true])('keeps Alice’s untouched value, not an earlier conflicting author (%s)', reverse => {
    const { alice, bob, carol, priority } = castle();
    bob.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
    carol.applyLocal({ type: 'set-game-name', name: 'Blue Castle' });
    const branches = [bob.getHistory(), carol.getHistory()];
    const result = reconcileHistories([alice.getHistory(), ...(reverse ? branches.reverse() : branches)], priority, namedRuntime('resolve'));
    expect(result.game.name).toBe('Old Castle');
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toMatchObject({ reason: 'concurrent-value', affected: ['game.name'], retained: 'Old Castle' });
    expect(result.notices[0].candidates.map(c => c.value).sort()).toEqual(['Blue Castle', 'Red Castle']);
    expect(result.notices[0].explanation).toMatch(/first room participant/i);
    expect(projectHistory(result.history)).toEqual(result.game);
  });

  it('independent records/fields', () => {
    const { alice, bob, carol, priority } = castle();
    bob.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
    carol.applyLocal({ type: 'set-player-name', playerId: 'bea', name: 'Bee' });
    carol.applyLocal({ type: 'set-player-role', playerId: 'bea', role: 'gm' });
    bob.applyLocal({ type: 'set-player-name', playerId: 'cy', name: 'Sy' });
    bob.applyLocal({ type: 'roll', playerId: 'alex', sides: 20 });
    carol.applyLocal({ type: 'roll', playerId: 'alex', sides: 20 });
    const result = reconcileHistories([alice.getHistory(), bob.getHistory(), carol.getHistory()], priority, namedRuntime('r'));
    expect(result.notices).toEqual([]);
    expect(result.game.name).toBe('Red Castle');
    expect(result.game.players).toEqual([{ id: 'alex', name: 'Alex', role: 'gm' }, { id: 'bea', name: 'Bee', role: 'gm' }, { id: 'cy', name: 'Sy', role: 'pj' }]);
    expect(result.game.rolls).toHaveLength(2);
    expect(resolutions(result.history)).toEqual([]);
  });

  it('single offline edit vs unchanged', () => {
    const { alice, bob, priority } = castle();
    bob.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
    const result = reconcileHistories([alice.getHistory(), bob.getHistory()], priority, namedRuntime('r'));
    expect(result.game.name).toBe('Red Castle');
    expect(result.notices).toEqual([]);
  });

  it('equal concurrent values', () => {
    const { alice, bob, carol, priority } = castle();
    bob.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
    carol.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
    const result = reconcileHistories([alice.getHistory(), bob.getHistory(), carol.getHistory()], priority, namedRuntime('r'));
    expect(result.game.name).toBe('Red Castle');
    expect(result.notices).toEqual([]);
  });

  it('observed resolution then new edit', () => {
    const { alice, bob, carol, priority } = castle();
    bob.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
    carol.applyLocal({ type: 'set-game-name', name: 'Blue Castle' });
    const first = reconcileHistories([alice.getHistory(), bob.getHistory(), carol.getHistory()], priority, namedRuntime('r'));
    bob.accept(first.history);
    bob.applyLocal({ type: 'set-game-name', name: 'Purple Castle' });
    const result = reconcileHistories([first.history, bob.getHistory()], priority, namedRuntime('r2'));
    expect(result.game.name).toBe('Purple Castle');
    expect(result.notices).toEqual([]);
  });

  it('Alice also edits', () => {
    const { alice, bob, carol, priority } = castle();
    bob.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
    carol.applyLocal({ type: 'set-game-name', name: 'Blue Castle' });
    alice.applyLocal({ type: 'set-game-name', name: 'Gold Castle' });
    const result = reconcileHistories([alice.getHistory(), bob.getHistory(), carol.getHistory()], priority, namedRuntime('r'));
    expect(result.game.name).toBe('Gold Castle');
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0].retained).toBe('Gold Castle');
  });

  describe('late Green descendant never saw Red/Blue resolution', () => {
    function setup() {
      const s = castle();
      s.bob.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
      s.carol.applyLocal({ type: 'set-game-name', name: 'Blue Castle' });
      const dave = forkTestWorkspace(s.bob, 'dave');
      dave.applyLocal({ type: 'set-game-name', name: 'Green Castle' });
      return { ...s, dave };
    }
    it('all-at-once delivery keeps Old', () => {
      const { alice, bob, carol, dave, priority } = setup();
      const result = reconcileHistories([alice.getHistory(), bob.getHistory(), carol.getHistory(), dave.getHistory()], priority, namedRuntime('r'));
      expect(result.game.name).toBe('Old Castle');
      expect(result.notices).toHaveLength(1);
    });
    it('split delivery extends the original conflict with the same fallback', () => {
      const { alice, bob, carol, dave, priority } = setup();
      const first = reconcileHistories([alice.getHistory(), bob.getHistory(), carol.getHistory()], priority, namedRuntime('r'));
      expect(first.game.name).toBe('Old Castle');
      const second = reconcileHistories([first.history, dave.getHistory()], priority, namedRuntime('r2'));
      expect(second.game.name).toBe('Old Castle');
      expect(second.notices).toHaveLength(1);
      const [prior] = resolutions(first.history);
      const extension = resolutions(second.history).find(op => op.id !== prior.id)!;
      expect(extension.type === 'resolution' && extension.extendedResolutionIds).toEqual([prior.id]);
      const all = reconcileHistories([alice.getHistory(), bob.getHistory(), carol.getHistory(), dave.getHistory()], priority, namedRuntime('other'));
      expect(second.notices[0].id).toBe(all.notices[0].id);
    });
  });

  it('Dave successor/fresh room starts at accepted Red', () => {
    const { alice, bob, carol } = castle();
    bob.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
    carol.applyLocal({ type: 'set-game-name', name: 'Blue Castle' });
    const dave = forkTestWorkspace(alice, 'dave');
    dave.accept(bob.getHistory());
    const succession = capturePriority(dave.getHistory(), dave.replicaId, 'tenure-2');
    const result = reconcileHistories([dave.getHistory(), carol.getHistory()], succession, namedRuntime('r'));
    expect(result.game.name).toBe('Red Castle');
    expect(result.notices[0].retained).toBe('Red Castle');
    const fresh = forkTestWorkspace(dave, 'fresh');
    const room = capturePriority(fresh.getHistory(), 'opener', 'room-2');
    expect(reconcileHistories([fresh.getHistory(), carol.getHistory()], room, namedRuntime('f')).game.name).toBe('Red Castle');
    // Within Alice's tenure the historical fallback is still Old.
    expect(reconcileHistories([dave.getHistory(), carol.getHistory()], capturePriority(alice.getHistory(), alice.replicaId, 'tenure-1'), namedRuntime('a')).game.name).toBe('Old Castle');
  });

  it('duplicate names/new records with dependent rolls keep a valid roster and an unrelated roll', () => {
    const { alice, bob, carol, priority } = castle();
    const bobAdd = addPlayer(bob, { id: 'dee-b', name: 'Dee', role: 'pj' }, 'bob-add');
    const carolAdd = addPlayer(carol, { id: 'dee-c', name: 'dee', role: 'gm' }, 'carol-add');
    bob.applyLocal({ type: 'roll', playerId: 'dee-b', sides: 20 });
    carol.applyLocal({ type: 'roll', playerId: 'dee-c', sides: 6 });
    carol.applyLocal({ type: 'roll', playerId: 'alex', sides: 8 });
    const result = reconcileHistories([alice.getHistory(), bob.getHistory(), carol.getHistory()], priority, namedRuntime('r'));
    expect(result.game.players.map(p => p.id)).toEqual(['alex', 'bea', 'cy']);
    expect(result.game.rolls.map(r => r.playerId)).toEqual(['alex']);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0].reason).toBe('invariant');
    expect(result.notices[0].candidates.map(c => c.operationId).sort()).toEqual([bobAdd.id, carolAdd.id].sort());
    expect(result.history.operations[bobAdd.id]).toEqual(bobAdd);
    expect(result.history.operations[carolAdd.id]).toEqual(carolAdd);
    expect(projectHistory(result.history)).toEqual(result.game);
  });

  it('keeps the priority participant’s own new record on a duplicate name', () => {
    const { alice, bob, priority } = castle();
    addPlayer(alice, { id: 'dee-a', name: 'Dee', role: 'pj' }, 'alice-add');
    addPlayer(bob, { id: 'dee-b', name: 'Dee', role: 'pj' }, 'bob-add');
    const result = reconcileHistories([alice.getHistory(), bob.getHistory()], priority, namedRuntime('r'));
    expect(result.game.players.map(p => p.id)).toEqual(['alex', 'bea', 'cy', 'dee-a']);
  });

  it('diverged legacy seeds use limited-history and never infer deletion from absence', () => {
    const base = fixtureRoster();
    const a = { ...base, name: 'Legacy A', players: [...base.players, { id: 'dee', name: 'Dee', role: 'pj' as const }] };
    const b = { ...base, name: 'Legacy B', players: base.players.filter(p => p.id !== 'cy').concat({ id: 'eve', name: 'Eve', role: 'pj' }), rolls: [{ id: 'roll-b', playerId: 'alex', sides: 6 as const, value: 3, at: base.createdAt }] };
    const ha: GameHistory = { modelVersion: 1, gameId: 'game', seeds: { 'legacy-a': a }, operations: {} };
    const hb: GameHistory = { modelVersion: 1, gameId: 'game', seeds: { 'legacy-b': b }, operations: {} };
    const priority = capturePriority(hb, 'opener', 'room');
    const result = reconcileHistories([ha, hb], priority, namedRuntime('r'));
    expect(result.game.name).toBe('Legacy B');
    expect(result.game.players.map(p => p.id).sort()).toEqual(['alex', 'bea', 'cy', 'dee', 'eve']);
    expect(result.game.rolls.map(r => r.id)).toEqual(['roll-b']);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toMatchObject({ reason: 'limited-history', affected: ['game.name'], retained: 'Legacy B' });
  });

  it('replayed resolutions do not duplicate notices or operations', () => {
    const { alice, bob, carol, priority } = castle();
    bob.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
    carol.applyLocal({ type: 'set-game-name', name: 'Blue Castle' });
    const inputs = [alice.getHistory(), bob.getHistory(), carol.getHistory()];
    const first = reconcileHistories(inputs, priority, namedRuntime('r'));
    const again = reconcileHistories([first.history, ...inputs, first.history], priority, namedRuntime('r2'));
    expect(again.notices).toEqual([]);
    expect(again.history).toEqual(first.history);
    expect(again.game).toEqual(first.game);
    bob.accept(first.history);
    const peer = reconcileHistories([bob.getHistory(), first.history], priority, namedRuntime('r3'));
    expect(peer.notices).toEqual([]);
  });

  it('shows a received resolution once to a peer that lacked it', () => {
    const { alice, bob, carol, priority } = castle();
    bob.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
    carol.applyLocal({ type: 'set-game-name', name: 'Blue Castle' });
    const first = reconcileHistories([alice.getHistory(), bob.getHistory(), carol.getHistory()], priority, namedRuntime('r'));
    const peer = reconcileHistories([bob.getHistory(), first.history], priority, namedRuntime('r3'));
    expect(peer.notices.map(n => n.id)).toEqual(first.notices.map(n => n.id));
    expect(Object.keys(peer.history.operations)).toEqual(Object.keys(first.history.operations));
  });

  it('keeps missing-dependency operations pending outside accepted history', () => {
    const { alice, bob, priority } = castle();
    bob.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
    bob.applyLocal({ type: 'set-game-name', name: 'Redder Castle' });
    const h = bob.getHistory(), [first, second] = Object.values(h.operations);
    const partial = { ...h, operations: { [second.id]: second } };
    const result = reconcileHistories([alice.getHistory(), partial], priority, namedRuntime('r'));
    expect(result.pendingIds).toEqual([second.id]);
    expect(result.history.operations[second.id]).toBeUndefined();
    expect(result.game.name).toBe('Old Castle');
    expect(first.id).not.toBe(second.id);
  });

  it('rejects reused operation IDs with different contents', () => {
    const { alice, bob, carol, priority } = castle();
    bob.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
    const forged = bob.getHistory(), [op] = Object.values(forged.operations);
    const other = { ...forged, operations: { [op.id]: { ...op, name: 'Forged' } } };
    const result = reconcileHistories([alice.getHistory(), bob.getHistory(), other, carol.getHistory()], priority, namedRuntime('r'));
    expect(result.rejectedIds).toEqual([op.id]);
    expect(result.game.name).toBe('Old Castle');
  });

  it.each(['first', 'second'])('produces identical values and notice identity with different runtimes (%s pass)', () => {
    const run = (runtime: Runtime, reverse: boolean) => {
      const { alice, bob, carol, priority } = castle();
      bob.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
      carol.applyLocal({ type: 'set-game-name', name: 'Blue Castle' });
      carol.applyLocal({ type: 'set-player-name', playerId: 'bea', name: 'Bee' });
      bob.applyLocal({ type: 'set-player-name', playerId: 'bea', name: 'Bay' });
      const branches = [bob.getHistory(), carol.getHistory()];
      return reconcileHistories([alice.getHistory(), ...(reverse ? branches.reverse() : branches)], priority, runtime);
    };
    const left = run(namedRuntime('x'), false), right = run(namedRuntime('y'), true);
    expect(left.game).toEqual(right.game);
    expect(left.notices).toEqual(right.notices);
    expect(left.notices.map(n => n.affected[0]).sort()).toEqual(['game.name', 'player:bea.name']);
    expect(left.game.players[1].name).toBe('Bea');
  });

  it('uses the first participant’s fallback when an observed write competes with an unobserved losing-branch descendant', () => {
    const { alice, bob, carol, priority } = castle();
    bob.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
    carol.applyLocal({ type: 'set-game-name', name: 'Blue Castle' });
    const first = reconcileHistories([alice.getHistory(), bob.getHistory(), carol.getHistory()], priority, namedRuntime('r'));
    bob.accept(first.history);
    bob.applyLocal({ type: 'set-game-name', name: 'Purple Castle' });
    carol.applyLocal({ type: 'set-game-name', name: 'Navy Castle' });
    const result = reconcileHistories([first.history, bob.getHistory(), carol.getHistory()], priority, namedRuntime('r2'));
    expect(result.game.name).toBe('Old Castle');
    expect(result.notices).toHaveLength(1);
  });

  it('isolates duplicate player-ID creations without discarding unrelated descendants', () => {
    const { alice, bob, carol, priority } = castle();
    const bobAdd = addPlayer(bob, { id: 'dee', name: 'Dee', role: 'pj' }, 'bob-add');
    const carolAdd = addPlayer(carol, { id: 'dee', name: 'Dina', role: 'gm' }, 'carol-add');
    bob.applyLocal({ type: 'roll', playerId: 'dee', sides: 20 });
    bob.applyLocal({ type: 'roll', playerId: 'alex', sides: 20 });
    carol.applyLocal({ type: 'set-player-name', playerId: 'bea', name: 'Bee' });
    const result = reconcileHistories([alice.getHistory(), bob.getHistory(), carol.getHistory()], priority, namedRuntime('r'));
    expect(result.rejectedIds).toEqual([]);
    expect(result.game.players.map(p => [p.id, p.name])).toEqual([['alex', 'Alex'], ['bea', 'Bee'], ['cy', 'Cy']]);
    expect(result.game.rolls.map(r => r.playerId)).toEqual(['alex']);
    expect(result.history.operations[bobAdd.id]).toEqual(bobAdd);
    expect(result.history.operations[carolAdd.id]).toEqual(carolAdd);
    expect(result.notices.some(n => n.reason === 'invariant' && n.candidates.some(c => c.operationId === bobAdd.id))).toBe(true);
    expect(projectHistory(result.history)).toEqual(result.game);
  });

  it('keeps the seed player when an operation re-creates its ID, quarantining only dependent rolls', () => {
    const { alice, bob, priority } = castle();
    const h = bob.getHistory(), seed = Object.keys(h.seeds)[0], at = '2026-01-01T00:00:00.000Z';
    const forged: GameHistory = { ...h, operations: {
      'x-1': { type: 'add-player', id: 'x-1', authorId: 'bob', parents: [seed], at, player: { id: 'cy', name: 'Cyrus', role: 'gm' } },
      'x-2': { type: 'roll', id: 'x-2', authorId: 'bob', parents: ['x-1'], at, playerId: 'alex', sides: 20, value: 5 },
      'x-3': { type: 'roll', id: 'x-3', authorId: 'bob', parents: ['x-2'], at, playerId: 'cy', sides: 20, value: 6 },
    } };
    const result = reconcileHistories([alice.getHistory(), forged], priority, namedRuntime('r'));
    expect(result.rejectedIds).toEqual([]);
    expect(result.game.players.find(p => p.id === 'cy')).toEqual({ id: 'cy', name: 'Cy', role: 'pj' });
    expect(result.game.rolls.map(r => r.id)).toEqual(['x-2']);
    expect(result.history.operations['x-3']).toBeDefined();
    expect(projectHistory(result.history)).toEqual(result.game);
  });

  it('resolves a legacy seed union beyond 32 players and keeps unrelated rolls', () => {
    const base = fixtureRoster(), extra = (p: string) => Array.from({ length: 17 }, (_, i) => ({ id: `${p}${i + 1}`, name: `${p.toUpperCase()} ${i + 1}`, role: 'pj' as const }));
    const a = { ...base, players: [...base.players, ...extra('a')] };
    const b = { ...base, players: [...base.players, ...extra('b')], rolls: [{ id: 'rb-alex', playerId: 'alex', sides: 6 as const, value: 2, at: base.createdAt }, { id: 'rb-b9', playerId: 'b9', sides: 6 as const, value: 4, at: base.createdAt }] };
    const ha: GameHistory = { modelVersion: 1, gameId: 'game', seeds: { 'legacy-a': a }, operations: {} };
    const hb: GameHistory = { modelVersion: 1, gameId: 'game', seeds: { 'legacy-b': b }, operations: {} };
    const result = reconcileHistories([ha, hb], capturePriority(ha, 'opener', 'room'), namedRuntime('r'));
    expect(result.game.players.map(p => p.id)).toEqual(a.players.map(p => p.id));
    expect(result.game.rolls.map(r => r.id)).toEqual(['rb-alex']);
    expect(result.notices.length).toBeGreaterThan(0);
  });

  it('quarantines later operations on a withheld player and keeps unrelated work', () => {
    const { alice, bob, carol, priority } = castle();
    addPlayer(bob, { id: 'dee-b', name: 'Dee', role: 'pj' }, 'bob-add');
    addPlayer(carol, { id: 'dee-c', name: 'Dee', role: 'pj' }, 'carol-add');
    const first = reconcileHistories([alice.getHistory(), bob.getHistory(), carol.getHistory()], priority, namedRuntime('r'));
    expect(first.game.players.map(p => p.id)).toEqual(['alex', 'bea', 'cy']);
    bob.applyLocal({ type: 'roll', playerId: 'dee-b', sides: 20 });
    bob.applyLocal({ type: 'set-player-name', playerId: 'dee-b', name: 'Deedee' });
    bob.applyLocal({ type: 'set-player-role', playerId: 'dee-b', role: 'gm' });
    bob.applyLocal({ type: 'roll', playerId: 'alex', sides: 20 });
    const second = reconcileHistories([first.history, bob.getHistory()], priority, namedRuntime('r2'));
    expect(second.game.players.map(p => p.id)).toEqual(['alex', 'bea', 'cy']);
    expect(second.game.rolls.map(r => r.playerId)).toEqual(['alex']);
    expect(second.rejectedIds).toEqual([]);
    expect(projectHistory(second.history)).toEqual(second.game);
    expect(reconcileHistories([second.history], priority, namedRuntime('r3')).notices).toEqual([]);
  });

  it('retains the priority version of a legacy roll-ID collision as limited-history', () => {
    const base = fixtureRoster(), at = base.createdAt;
    const a = { ...base, rolls: [{ id: 'r1', playerId: 'alex', sides: 6 as const, value: 3, at }] };
    const b = { ...base, rolls: [{ id: 'r1', playerId: 'alex', sides: 6 as const, value: 5, at }, { id: 'r2', playerId: 'bea', sides: 4 as const, value: 1, at }] };
    const ha: GameHistory = { modelVersion: 1, gameId: 'game', seeds: { 'z-legacy-a': a }, operations: {} };
    const hb: GameHistory = { modelVersion: 1, gameId: 'game', seeds: { 'a-legacy-b': b }, operations: {} };
    const result = reconcileHistories([hb, ha], capturePriority(ha, 'opener', 'room'), namedRuntime('r'));
    expect(result.game.rolls.find(r => r.id === 'r1')?.value).toBe(3);
    expect(result.game.rolls.map(r => r.id).sort()).toEqual(['r1', 'r2']);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toMatchObject({ reason: 'limited-history', affected: ['roll:r1'] });
    expect(projectHistory(result.history)).toEqual(result.game);
  });

  it('treats histories[0] as local and later peer histories as unordered', () => {
    const { alice, bob, carol, priority } = castle();
    bob.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
    carol.applyLocal({ type: 'set-game-name', name: 'Blue Castle' });
    const dave = forkTestWorkspace(bob, 'dave');
    dave.applyLocal({ type: 'set-player-name', playerId: 'bea', name: 'Bee' });
    const peers = [bob.getHistory(), carol.getHistory(), dave.getHistory()];
    const one = reconcileHistories([alice.getHistory(), ...peers], priority, namedRuntime('p'));
    const two = reconcileHistories([alice.getHistory(), peers[2], peers[0], peers[1]], priority, namedRuntime('q'));
    expect(two.game).toEqual(one.game);
    expect(two.notices).toEqual(one.notices);
    expect(reconcileHistories([one.history, ...peers.reverse()], priority, namedRuntime('s')).notices).toEqual([]);
  });

  it('fails closed on wrong-game histories, isolates malformed operations, and never mutates inputs', () => {
    const { alice, bob, priority } = castle();
    bob.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
    const good = bob.getHistory(), local = alice.getHistory();
    expect(() => reconcileHistories([local, { ...good, gameId: 'other' }], priority, namedRuntime('r'))).toThrow(/game ID/);
    const bad = { ...good, operations: { ...good.operations, junk: { id: 'junk', type: 'explode' } } } as unknown as GameHistory;
    const snapshot = structuredClone([local, bad, priority]);
    const result = reconcileHistories([local, bad], priority, namedRuntime('r'));
    expect(result.rejectedIds).toEqual(['junk']);
    expect(result.game.name).toBe('Red Castle');
    expect([local, bad, priority]).toEqual(snapshot);
  });

  it('accounts for more than 128 competing same-field heads with bounded resolutions', () => {
    const { alice, priority } = castle();
    const h = alice.getHistory(), seed = Object.keys(h.seeds)[0], at = '2026-01-01T00:00:00.000Z';
    const operations: GameHistory['operations'] = {};
    for (let i = 0; i < 300; i++) operations[`n-${i}`] = { type: 'set-game-name', id: `n-${i}`, authorId: `p${i}`, parents: [seed], at, name: `Name ${i}` };
    const result = reconcileHistories([h, { ...h, operations }], priority, namedRuntime('r'));
    expect(result.game.name).toBe('Old Castle');
    expect(Object.keys(operations).every(id => result.history.operations[id])).toBe(true);
    const made = resolutions(result.history);
    expect(made.every(op => op.type === 'resolution' && op.candidateHeads.length <= 128 && op.parents.length <= 128)).toBe(true);
    const accounted = new Set(made.flatMap(op => op.type === 'resolution' ? op.candidateHeads : []));
    expect(Object.keys(operations).every(id => accounted.has(id))).toBe(true);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0].candidates).toHaveLength(300);
    expect(projectHistory(result.history)).toEqual(result.game);
    expect(reconcileHistories([result.history], priority, namedRuntime('again')).history).toEqual(result.history);
  });

  it('keeps the priority participant’s valid edits to a kept player on an ID collision', () => {
    const { alice, bob, carol, priority } = castle();
    alice.applyLocal({ type: 'set-player-name', playerId: 'cy', name: 'Cyan' });
    alice.applyLocal({ type: 'set-player-role', playerId: 'cy', role: 'gm' });
    carol.applyLocal({ type: 'set-player-name', playerId: 'bea', name: 'Bee' });
    const h = bob.getHistory(), seed = Object.keys(h.seeds)[0], at = '2026-01-01T00:00:00.000Z';
    const forged: GameHistory = { ...h, operations: {
      'x-1': { type: 'add-player', id: 'x-1', authorId: 'bob', parents: [seed], at, player: { id: 'cy', name: 'Cyrus', role: 'pj' } },
      'x-2': { type: 'roll', id: 'x-2', authorId: 'bob', parents: ['x-1'], at, playerId: 'alex', sides: 20, value: 5 },
    } };
    const result = reconcileHistories([alice.getHistory(), forged, carol.getHistory()], priority, namedRuntime('r'));
    expect(result.game.players).toEqual([{ id: 'alex', name: 'Alex', role: 'gm' }, { id: 'bea', name: 'Bee', role: 'pj' }, { id: 'cy', name: 'Cyan', role: 'gm' }]);
    expect(result.game.rolls.map(r => r.id)).toEqual(['x-2']);
    expect(projectHistory(result.history)).toEqual(result.game);
  });

  describe('roster bound follows priority, not ID order', () => {
    const roster = (n: number) => ({ ...fixtureRoster(), name: 'Old Castle', players: Array.from({ length: n }, (_, i) => ({ id: `p${String(i).padStart(2, '0')}`, name: `P ${i}`, role: 'pj' as const })) });
    it('keeps the baseline roster when the priority added neither record', () => {
      const alice = createTestWorkspace('alice', roster(31));
      const bob = forkTestWorkspace(alice, 'bob'), carol = forkTestWorkspace(alice, 'carol');
      const priority = capturePriority(alice.getHistory(), alice.replicaId, 't');
      const b = addPlayer(bob, { id: 'aaa', name: 'Bobby', role: 'pj' }, 'bob-add');
      const c = addPlayer(carol, { id: 'zzz', name: 'Carly', role: 'pj' }, 'carol-add');
      carol.applyLocal({ type: 'roll', playerId: 'p00', sides: 6 });
      bob.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
      const result = reconcileHistories([alice.getHistory(), bob.getHistory(), carol.getHistory()], priority, namedRuntime('r'));
      expect(result.game.players.map(p => p.id)).toEqual(roster(31).players.map(p => p.id));
      expect(result.game.rolls.map(r => r.playerId)).toEqual(['p00']);
      expect(result.game.name).toBe('Red Castle');
      expect(result.history.operations[b.id]).toEqual(b);
      expect(result.history.operations[c.id]).toEqual(c);
      expect(projectHistory(result.history)).toEqual(result.game);
    });
    it('retains the priority participant’s own addition and withholds the other', () => {
      const alice = createTestWorkspace('alice', roster(31));
      const bob = forkTestWorkspace(alice, 'bob');
      const priority = capturePriority(alice.getHistory(), alice.replicaId, 't');
      addPlayer(alice, { id: 'zzz', name: 'Alicia', role: 'pj' }, 'alice-add');
      addPlayer(bob, { id: 'aaa', name: 'Bobby', role: 'pj' }, 'bob-add');
      const result = reconcileHistories([alice.getHistory(), bob.getHistory()], priority, namedRuntime('r'));
      expect(result.game.players.map(p => p.id)).toEqual([...roster(31).players.map(p => p.id), 'zzz']);
      expect(projectHistory(result.history)).toEqual(result.game);
    });
  });

  it('quarantines concurrent renames of an already-withheld player instead of crashing', () => {
    const { alice, bob, carol, priority } = castle();
    addPlayer(bob, { id: 'dee-b', name: 'Dee', role: 'pj' }, 'bob-add');
    addPlayer(carol, { id: 'dee-c', name: 'Dee', role: 'pj' }, 'carol-add');
    const first = reconcileHistories([alice.getHistory(), bob.getHistory(), carol.getHistory()], priority, namedRuntime('r'));
    const bob2 = forkTestWorkspace(bob, 'bob2');
    bob.applyLocal({ type: 'set-player-name', playerId: 'dee-b', name: 'Dot' });
    bob2.applyLocal({ type: 'set-player-name', playerId: 'dee-b', name: 'Dax' });
    bob.applyLocal({ type: 'roll', playerId: 'alex', sides: 20 });
    carol.applyLocal({ type: 'set-player-name', playerId: 'bea', name: 'Bee' });
    const second = reconcileHistories([first.history, bob.getHistory(), bob2.getHistory(), carol.getHistory()], priority, namedRuntime('r2'));
    expect(second.game.players.map(p => [p.id, p.name])).toEqual([['alex', 'Alex'], ['bea', 'Bee'], ['cy', 'Cy']]);
    expect(second.game.rolls.map(r => r.playerId)).toEqual(['alex']);
    expect(projectHistory(second.history)).toEqual(second.game);
    expect(second.notices.some(n => n.reason === 'invariant' && n.candidates.some(c => c.operationId === 'bob-1') && n.candidates.some(c => c.operationId === 'bob2-1'))).toBe(true);
    expect(reconcileHistories([second.history], priority, namedRuntime('r3')).history).toEqual(second.history);
  });

  it('orders more than 128 roll removals causally after the rolls they remove', () => {
    const { alice, bob, carol, priority } = castle();
    const add = addPlayer(bob, { id: 'dee-b', name: 'Dee', role: 'pj' }, 'bob-add');
    addPlayer(carol, { id: 'dee-c', name: 'Dee', role: 'pj' }, 'carol-add');
    bob.applyLocal({ type: 'roll', playerId: 'alex', sides: 20 });
    carol.applyLocal({ type: 'roll', playerId: 'alex', sides: 8 });
    // 140 mutually concurrent dependent rolls: none is an ancestor of another.
    const h = bob.getHistory(), at = '2026-01-01T00:00:00.000Z', rolls: GameHistory['operations'] = {};
    for (let i = 0; i < 140; i++) rolls[`d-${String(i).padStart(3, '0')}`] = { type: 'roll', id: `d-${String(i).padStart(3, '0')}`, authorId: `p${i}`, parents: [add.id], at, playerId: 'dee-b', sides: 6, value: 1 };
    const result = reconcileHistories([alice.getHistory(), { ...h, operations: { ...h.operations, ...rolls } }, carol.getHistory()], priority, namedRuntime('r'));
    expect(projectHistory(result.history)).toEqual(result.game);
    expect(result.game.rolls.map(r => r.playerId)).toEqual(['alex', 'alex']);
    const ops = result.history.operations;
    const ancestors = (id: string) => { const seen = new Set<string>(), stack = [...(ops[id]?.parents ?? [])]; while (stack.length) { const x = stack.pop()!; if (!seen.has(x)) { seen.add(x); stack.push(...(ops[x]?.parents ?? [])); } } return seen; };
    let removals = 0;
    for (const op of resolutions(result.history)) {
      if (op.type !== 'resolution') continue;
      expect(op.patches.length).toBeLessThanOrEqual(128);
      expect(op.parents.length).toBeLessThanOrEqual(128);
      expect(op.candidateHeads.length).toBeLessThanOrEqual(128);
      const past = ancestors(op.id);
      for (const p of op.patches) if (p.type === 'remove-roll') { removals++; if (ops[p.rollId]) expect(past.has(p.rollId)).toBe(true); }
    }
    expect(removals).toBeGreaterThanOrEqual(140);
  }, 60000);

  it('reports the actual competing proposals when a priority edit extends an earlier resolution', () => {
    const { alice, bob, carol, priority } = castle();
    bob.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
    carol.applyLocal({ type: 'set-game-name', name: 'Blue Castle' });
    const first = reconcileHistories([alice.getHistory(), bob.getHistory(), carol.getHistory()], priority, namedRuntime('r'));
    expect(first.game.name).toBe('Old Castle');
    alice.applyLocal({ type: 'set-game-name', name: 'Gold Castle' });
    alice.accept(bob.getHistory()); alice.accept(carol.getHistory());
    const result = reconcileHistories([first.history, alice.getHistory()], priority, namedRuntime('r2'));
    expect(result.game.name).toBe('Gold Castle');
    expect(result.notices).toHaveLength(1);
    const [notice] = result.notices;
    expect(notice).toMatchObject({ reason: 'concurrent-value', affected: ['game.name'], retained: 'Gold Castle' });
    expect(notice.candidates.map(c => c.value).sort()).toEqual(['Blue Castle', 'Gold Castle', 'Red Castle']);
    expect(notice.explanation).toContain('Gold Castle');
    expect(notice.explanation).toMatch(/first room participant/i);
    expect(reconcileHistories([result.history, alice.getHistory()], priority, namedRuntime('r3')).notices).toEqual([]);
  });

  it('chains a pure-roll legacy collision with more than 128 seed candidates', () => {
    const base = fixtureRoster(), at = base.createdAt;
    const keep = { id: 'keep', playerId: 'alex', sides: 6 as const, value: 2, at };
    const baseline: GameHistory = { modelVersion: 1, gameId: 'game', seeds: { base: { ...base, rolls: [keep] } }, operations: {} };
    const seeds: GameHistory['seeds'] = {};
    for (let i = 0; i < 130; i++) seeds[`s${String(i).padStart(3, '0')}`] = { ...base, rolls: [i < 100 ? { id: 'shared', playerId: 'bea', sides: 100 as const, value: i + 1, at } : { id: 'shared', playerId: 'alex', sides: 100 as const, value: i - 99, at }] };
    const result = reconcileHistories([baseline, { modelVersion: 1, gameId: 'game', seeds, operations: {} }], capturePriority(baseline, 'opener', 'room'), namedRuntime('r'));
    expect(result.game.rolls).toEqual([keep]);
    expect(projectHistory(result.history)).toEqual(result.game);
    expect(Object.keys(result.history.seeds)).toHaveLength(131);
    for (const op of resolutions(result.history)) if (op.type === 'resolution') {
      for (const list of [op.parents, op.candidateHeads, op.patches, op.fallbackBase, op.fallbackFrontier, op.extendedResolutionIds]) expect(list.length).toBeLessThanOrEqual(128);
      expect(op.patches.every(p => p.type === 'remove-roll' && p.rollId === 'shared')).toBe(true);
    }
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toMatchObject({ reason: 'limited-history', affected: ['roll:shared'] });
    expect(result.notices[0].candidates).toHaveLength(130);
    expect(reconcileHistories([result.history], capturePriority(baseline, 'opener', 'room'), namedRuntime('again')).history).toEqual(result.history);
  });
});
