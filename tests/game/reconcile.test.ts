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
});
