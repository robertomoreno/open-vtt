import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createWorkspace, validateWorkspaceSnapshot } from '../../src/game/workspace';
import { createTestWorkspace, forkTestWorkspace, namedRuntime } from '../helpers/workspace';

describe('local workspaces', () => {
  it('preserves lineage across fork/save/reload instead of reseeding JSON', () => {
    const a = createTestWorkspace('a');
    const b = forkTestWorkspace(a, 'b');
    b.applyLocal({ type: 'roll', playerId: 'alex', sides: 20 });
    const restored = createWorkspace(b.getSnapshot(), namedRuntime('restored'));
    expect(restored.getHistory()).toEqual(b.getHistory());
    expect(restored.getSnapshot().game.rolls).toHaveLength(1);
    expect(restored.replicaId).not.toBe(b.replicaId);
  });

  it('returns detached getters and validates the snapshot against actual Yjs history', () => {
    const w = createTestWorkspace('a');
    const h = w.getHistory(), snapshot = w.getSnapshot();
    h.seeds[Object.keys(h.seeds)[0]].name = 'tampered';
    snapshot.game.name = 'tampered';
    snapshot.history.fill(0);
    expect(w.getSnapshot().game.name).toBe('Castle');
    expect(() => validateWorkspaceSnapshot(snapshot)).toThrow();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, w.getSnapshot().history);
    expect(doc.getMap('seeds').size).toBe(1);
    expect(doc.getMap('operations').size).toBe(0);
    doc.destroy();
  });

  it('validates projections, revisions, causal order and notifications without wall-clock authority', () => {
    const w = createTestWorkspace('a');
    let changes = 0;
    const unsubscribe = w.subscribe(() => changes++);
    w.applyLocal({ type: 'set-game-name', name: 'Keep' });
    w.applyLocal({ type: 'set-player-name', playerId: 'bea', name: 'Bee' });
    w.applyLocal({ type: 'set-player-role', playerId: 'cy', role: 'gm' });
    w.applyLocal({ type: 'roll', playerId: 'alex', sides: 20 });
    unsubscribe();
    w.applyLocal({ type: 'roll', playerId: 'alex', sides: 20 });
    const snapshot = w.getSnapshot(), ops = Object.values(w.getHistory().operations);
    expect(changes).toBe(4);
    expect(snapshot.game).toMatchObject({ name: 'Keep', revision: 5, updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(snapshot.game.players[1].name).toBe('Bee');
    expect(snapshot.game.players[2].role).toBe('gm');
    expect(snapshot.game.rolls.map(r => r.id)).toEqual([ops[3].id, ops[4].id]);
    expect(ops[4].parents).toEqual([ops[3].id]);
    expect(ops.every(op => op.authorId === 'a')).toBe(true);
    expect(() => validateWorkspaceSnapshot({ ...snapshot, game: { ...snapshot.game, name: 'Forged' } })).toThrow();
    expect(w.getSnapshot()).toEqual(snapshot);
  });

  it('does not return deleted non-game payloads from untrusted Yjs updates', () => {
    const snapshot = createTestWorkspace('a').getSnapshot();
    const untrusted = new Y.Doc({ gc: false });
    Y.applyUpdate(untrusted, snapshot.history);
    untrusted.getMap('meta').set('temporary', 'sensitive-non-game-payload');
    untrusted.getMap('meta').delete('temporary');
    const history = Y.encodeStateAsUpdate(untrusted);
    expect(new TextDecoder().decode(history)).toContain('sensitive-non-game-payload');
    const validated = validateWorkspaceSnapshot({ ...snapshot, history });
    expect(new TextDecoder().decode(validated.history)).not.toContain('sensitive-non-game-payload');
    expect(validated.game).toEqual(snapshot.game);
    untrusted.destroy();
  });

  it('rejects concurrent Yjs entries reusing a semantic operation ID with different content', () => {
    const root = createTestWorkspace('root');
    const a = forkTestWorkspace(root, 'same'), b = forkTestWorkspace(root, 'same');
    a.applyLocal({ type: 'set-game-name', name: 'Red' });
    b.applyLocal({ type: 'set-game-name', name: 'Blue' });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, a.getSnapshot().history);
    Y.applyUpdate(doc, b.getSnapshot().history);
    const entries = [...doc.getMap('operations').values()];
    const visible = entries[0] as { name?: string } | undefined;
    const game = visible?.name === 'Blue' ? b.getSnapshot().game : a.getSnapshot().game;
    expect(() => validateWorkspaceSnapshot({ game, history: Y.encodeStateAsUpdate(doc) })).toThrow(/collision/i);
    doc.destroy();
  });

  it('retains causal evidence for 600 rolls and does not resurrect trimmed rolls on old replay', () => {
    const w = createTestWorkspace('a');
    for (let i = 0; i < 300; i++) w.applyLocal({ type: 'roll', playerId: 'alex', sides: 20 });
    const old = forkTestWorkspace(w, 'old');
    const oldRolls = old.getSnapshot().game.rolls.map(roll => roll.id);
    for (let i = 0; i < 300; i++) w.applyLocal({ type: 'roll', playerId: 'alex', sides: 20 });
    const before = w.getSnapshot().game.rolls;
    expect(before).toHaveLength(100);
    expect(new Set(before.map(r => r.id)).size).toBe(100);
    expect(Object.keys(w.getHistory().operations)).toHaveLength(600);
    w.accept(old.getHistory());
    expect(w.getSnapshot().game.rolls).toEqual(before);
    expect(before.some(roll => oldRolls.includes(roll.id))).toBe(false);
  }, 30000);

  it('rejects growing past the entry bound without damaging a downloadable snapshot', () => {
    const w = createTestWorkspace('bound');
    for (let i = 0; i < 4095; i++) w.applyLocal({ type: 'set-game-name', name: `Game ${i}` });
    const before = w.getSnapshot();
    expect(() => w.applyLocal({ type: 'set-game-name', name: 'Overflow' })).toThrow();
    expect(w.getSnapshot()).toEqual(before);
    expect(validateWorkspaceSnapshot(before).game.name).toBe('Game 4094');
  }, 120000);

  it('rejects growing past the encoded history bound without damaging a downloadable snapshot', () => {
    const w = createTestWorkspace('bytes');
    let before = w.getSnapshot();
    let rejected = false;
    for (let i = 0; i < 4095; i++) {
      try {
        w.applyLocal({ type: 'set-game-name', name: '🏰'.repeat(100) });
        before = w.getSnapshot();
      } catch { rejected = true; break; }
    }
    expect(rejected).toBe(true);
    expect(Object.keys(w.getHistory().operations).length).toBeLessThan(4095);
    expect(w.getSnapshot()).toEqual(before);
    expect(validateWorkspaceSnapshot(before).game).toEqual(before.game);
  }, 120000);
});
