import { describe, expect, it } from 'vitest';
import { mergeHistory, projectHistory, makeRosterAddition } from '../../src/game/history';
import { createTestWorkspace, fixtureRoster, forkTestWorkspace, namedRuntime } from '../helpers/workspace';

describe('causal history', () => {
  it('rejects reused IDs with different contents and distinguishes missing parents from cycles', () => {
    const w = createTestWorkspace('a');
    w.applyLocal({ type: 'set-game-name', name: 'New' });
    const before = w.getSnapshot(), h = w.getHistory();
    const op = Object.values(h.operations)[0];
    expect(() => w.accept({ ...h, operations: { ...h.operations, [op.id]: { ...op, authorId: 'other' } } })).toThrow(/collision/i);
    expect(() => w.accept({ ...h, operations: { ...h.operations, [op.id]: { ...op, parents: [op.id] } } })).toThrow();
    const cyclic = { ...h, operations: { ...h.operations, [op.id]: { ...op, parents: [op.id] } } };
    expect(() => projectHistory(cyclic)).toThrow(/cycle/i);
    const missing = { ...h, operations: { ...h.operations, [op.id]: { ...op, parents: ['missing'] } } };
    expect(() => projectHistory(missing)).toThrow(/missing/i);
    expect(w.getSnapshot()).toEqual(before);
  });

  it('rejects invalid game IDs, references, roles, dice, and unsupported fields', () => {
    const w = createTestWorkspace('valid');
    const h = w.getHistory();
    expect(() => mergeHistory(h, { ...h, gameId: 'wrong' })).toThrow();
    expect(() => w.applyLocal({ type: 'set-player-role', playerId: 'alex', role: 'king' } as never)).toThrow();
    expect(() => w.applyLocal({ type: 'roll', playerId: 'alex', sides: 5 } as never)).toThrow();
    expect(() => w.applyLocal({ type: 'roll', playerId: 'unknown', sides: 20 })).toThrow();
    expect(() => w.applyLocal({ type: 'set-game-name', name: 'X', extra: 1 } as never)).toThrow();
    expect(() => w.applyLocal({ type: 'add-player', player: fixtureRoster().players[0] } as never)).toThrow();
    expect(w.getHistory()).toEqual(h);
  });

  it('constructs a validated roster addition with the current causal frontier', () => {
    const w = createTestWorkspace('a');
    const h = w.getHistory();
    const op = makeRosterAddition(h, { id: 'dee', name: 'Dee', role: 'pj' }, namedRuntime('addition'), 'author');
    const merged = mergeHistory(h, { ...h, operations: { [op.id]: op } });
    expect(projectHistory(merged).players.map(p => p.id)).toEqual(['alex', 'bea', 'cy', 'dee']);
    expect(op.authorId).toBe('author');
    expect(op.parents).toEqual(Object.keys(h.seeds));
  });

  it('rejects roster operation IDs already in history', () => {
    const w = createTestWorkspace('a');
    const runtime = namedRuntime('addition');
    const first = makeRosterAddition(w.getHistory(), { id: 'dee', name: 'Dee', role: 'pj' }, runtime, 'author');
    w.accept({ ...w.getHistory(), operations: { [first.id]: first } });
    expect(() => makeRosterAddition(w.getHistory(), { id: 'eli', name: 'Eli', role: 'pj' }, namedRuntime('addition'), 'author')).toThrow(/collision/i);
  });

  it('rejects resolutions that reference missing or non-resolution evidence', () => {
    const w = createTestWorkspace('a');
    w.applyLocal({ type: 'set-game-name', name: 'New' });
    const h = w.getHistory(), original = Object.values(h.operations)[0], seed = Object.keys(h.seeds)[0];
    const resolution = { type: 'resolution' as const, id: 'resolve', authorId: 'resolver', parents: [original.id], at: original.at, patches: [{ type: 'set-game-name' as const, name: 'Castle' }], candidateHeads: ['absent'], fallbackBase: [seed], fallbackFrontier: [seed], extendedResolutionIds: [] };
    expect(() => projectHistory({ ...h, operations: { ...h.operations, resolve: resolution } })).toThrow(/missing/i);
    expect(() => projectHistory({ ...h, operations: { ...h.operations, resolve: { ...resolution, candidateHeads: [original.id], extendedResolutionIds: [original.id] } } })).toThrow(/resolution/i);
    expect(projectHistory({ ...h, operations: { ...h.operations, resolve: { ...resolution, candidateHeads: [original.id] } } }).name).toBe('Castle');
  });

  it('merges independent rolls in deterministic causal order irrespective of delivery order', () => {
    const root = createTestWorkspace('root'), a = forkTestWorkspace(root, 'a'), b = forkTestWorkspace(root, 'b');
    a.applyLocal({ type: 'roll', playerId: 'alex', sides: 20 });
    b.applyLocal({ type: 'roll', playerId: 'bea', sides: 6 });
    const left = projectHistory(mergeHistory(a.getHistory(), b.getHistory()));
    const right = projectHistory(mergeHistory(b.getHistory(), a.getHistory()));
    expect(left).toEqual(right);
    expect(left.rolls.map(roll => roll.playerId)).toEqual(['alex', 'bea']);
    expect(left.rolls.map(roll => roll.value)).toEqual([7, 6]);
    expect(left.revision).toBe(2);
  });

  it('defers projection collisions only while a descendant resolution accounts for them', () => {
    const base = fixtureRoster(), at = base.createdAt;
    const history = {
      modelVersion: 1 as const, gameId: 'game',
      seeds: { s1: { ...base, rolls: [{ id: 'r1', playerId: 'alex', sides: 6 as const, value: 3, at }] }, s2: { ...base, rolls: [{ id: 'r1', playerId: 'alex', sides: 6 as const, value: 5, at }] } },
      operations: {
        a: { type: 'add-player' as const, id: 'a', authorId: 'x', parents: ['s1'], at, player: { id: 'cy', name: 'Cyrus', role: 'gm' as const } },
        b: { type: 'set-player-name' as const, id: 'b', authorId: 'x', parents: ['s1'], at, playerId: 'ghost', name: 'Boo' },
      },
    };
    expect(() => projectHistory(history)).toThrow(/collision|duplicate|unknown/i);
    const resolve = { type: 'resolution' as const, id: 'z', authorId: 'x', parents: ['a', 'b', 's2'], at, patches: [{ type: 'put-roll' as const, roll: { id: 'r1', playerId: 'alex', sides: 6 as const, value: 3, at } }], candidateHeads: ['a', 'b', 's2'], fallbackBase: [], fallbackFrontier: ['s1'], extendedResolutionIds: [] };
    const game = projectHistory({ ...history, operations: { ...history.operations, z: resolve } });
    expect(game.players.find(p => p.id === 'cy')?.name).toBe('Cy');
    expect(game.rolls).toEqual([{ id: 'r1', playerId: 'alex', sides: 6, value: 3, at }]);
    expect(() => projectHistory({ ...history, operations: { ...history.operations, z: { ...resolve, candidateHeads: ['a', 's2'] } } })).toThrow(/unknown/i);
  });
});
