import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { GameHistory, GameOperation } from '../../src/game/sync-types';
import type { Game, Runtime } from '../../src/game/types';
import { validateOperation } from '../../src/game/history';
import { ValidationError } from '../../src/game/validation';
import { createWorkspace, type Workspace } from '../../src/game/workspace';
import { CONTROL_ENTRIES, GAME_OPERATIONS, MISSING_DEPENDENCY_OPERATIONS } from '../../src/network/limits';
import {
  STAGE_CONTROL,
  STAGE_ENTRIES,
  createWorkspaceBridge,
  readControlEvents,
  readStagedHistory,
  snapshotFromHistory,
  writeControlEvent,
} from '../../src/session/workspace-bridge';
import type { MembershipEvent } from '../../src/session/membership';
import { createTestWorkspace, fixtureRoster, namedRuntime } from '../helpers/workspace';

const AT = '2026-01-01T00:00:00.000Z';

function soloGame(): Game {
  return { schemaVersion: 1, id: 'game', name: 'Castle', createdAt: AT, updatedAt: AT, revision: 0, players: [{ id: 'alex', name: 'Alex', role: 'gm' }], rolls: [] };
}
function soloWorkspace(label: string): Workspace {
  return createWorkspace(soloGame(), namedRuntime(label), label);
}
/** The seed id of a workspace history: the only causal root local operations can cite. */
function seedIdOf(ws: Workspace): string {
  return Object.keys(ws.getHistory().seeds)[0];
}
function roll(id: string, parents: string[], over: Partial<GameOperation> = {}): GameOperation {
  return validateOperation({ type: 'roll', id, authorId: 'peer', playerId: 'alex', sides: 6, value: 3, at: AT, parents, ...over });
}
/** Writes raw staging entries exactly as a remote (possibly malicious) peer would. */
function stageRaw(stage: Y.Doc, keys: string[]) {
  stage.transact(() => { for (const key of keys) stage.getMap(STAGE_ENTRIES).set(key, true); });
}
function stagedKeys(stage: Y.Doc): string[] {
  return [...stage.getMap(STAGE_ENTRIES).keys()];
}
function setup(label = 'w') {
  const stage = new Y.Doc();
  const ws = soloWorkspace(label);
  const bridge = createWorkspaceBridge(stage, ws);
  return { stage, ws, bridge };
}

describe('workspace bridge', () => {
  it('round-trips a published history as one candidate', () => {
    const { ws, bridge } = setup();
    ws.applyLocal({ type: 'roll', playerId: 'alex', sides: 6 });
    bridge.publish(ws.getHistory());
    const candidates = bridge.readCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].gameId).toBe('game');
    expect(Object.keys(candidates[0].operations).sort()).toEqual(Object.keys(ws.getHistory().operations).sort());
    // Admitting the union of local and staged content is a safe no-op.
    bridge.admit(candidates[0]);
    expect(ws.getSnapshot().game.rolls).toHaveLength(1);
  });

  it('admits a valid staged remote operation into the durable workspace', () => {
    const { stage, ws, bridge } = setup();
    const before = ws.getSnapshot();
    stageRaw(stage, [JSON.stringify(roll('good-1', [seedIdOf(ws)]))]);
    const candidates = bridge.readCandidates();
    expect(candidates).toHaveLength(1);
    bridge.admit(candidates[0]);
    expect(ws.getSnapshot().game.rolls).toHaveLength(1);
    expect(ws.getSnapshot().game.rolls[0].playerId).toBe('alex');
    expect(before.game.rolls).toHaveLength(0);
  });

  it('keeps pending operations staged until their dependencies arrive', () => {
    const { stage, ws, bridge } = setup();
    const seed = seedIdOf(ws);
    const child = roll('child-1', ['missing-parent']);
    stageRaw(stage, [JSON.stringify(child)]);
    // Task 4 contract: a pending id carries no payload out of reconciliation; the payload
    // must remain in the caller-owned staging doc until the parent arrives.
    expect(bridge.readCandidates()).toEqual([]);
    expect(stagedKeys(stage)).toContain(JSON.stringify(child));
    const parent = roll('missing-parent', [seed]);
    stageRaw(stage, [JSON.stringify(parent)]);
    const candidates = bridge.readCandidates();
    expect(candidates).toHaveLength(1);
    expect(Object.keys(candidates[0].operations).sort()).toEqual(['child-1', 'missing-parent']);
    bridge.admit(candidates[0]);
    expect(Object.keys(ws.getHistory().operations).sort()).toEqual(['child-1', 'missing-parent']);
  });

  it('rejects ID rewrites and conflicting duplicates while valid independent operations survive', () => {
    const { stage, ws, bridge } = setup();
    const seed = seedIdOf(ws);
    const accepted = ws.getSnapshot();
    // A canonical-looking entry whose recorded key does not match its normalized payload.
    const rewritten = roll('rewrite-1', [seed]);
    const scrambledKey = JSON.stringify({ type: 'roll', value: 3, id: 'rewrite-1', authorId: 'peer', playerId: 'alex', sides: 6, at: AT, parents: [seed] });
    // Two different payloads claiming the same immutable operation id.
    const dupA = roll('dup-1', [seed], { value: 1 });
    const dupB = roll('dup-1', [seed], { value: 6 });
    stageRaw(stage, ['{{{ not json', scrambledKey, JSON.stringify(dupA), JSON.stringify(dupB), JSON.stringify(roll('good-1', [seed]))]);
    expect(scrambledKey).not.toBe(JSON.stringify(rewritten));
    const candidates = bridge.readCandidates();
    expect(candidates).toHaveLength(1);
    expect(Object.keys(candidates[0].operations)).toEqual(['good-1']);
    bridge.admit(candidates[0]);
    const after = ws.getSnapshot();
    expect(after.game.rolls).toHaveLength(1);
    expect(after.game.rolls[0].sides).toBe(6);
    expect(after.game.players).toEqual(accepted.game.players);
  });

  it('rejects a staged seed that rewrites an accepted seed id', () => {
    const { stage, ws, bridge } = setup();
    const seed = seedIdOf(ws);
    const before = ws.getSnapshot();
    stageRaw(stage, [JSON.stringify([seed, { ...soloGame(), name: 'Stolen' }])]);
    expect(bridge.readCandidates()).toEqual([]);
    bridge.admit(ws.getHistory());
    expect(ws.getSnapshot().game.name).toBe(before.game.name);
  });

  it('rejects dependency overflow beyond the missing-dependency bound', () => {
    const { stage, ws, bridge } = setup();
    const seed = seedIdOf(ws);
    const before = ws.getSnapshot();
    const flood = Array.from({ length: MISSING_DEPENDENCY_OPERATIONS + 5 }, (_, i) => JSON.stringify(roll(`orphan-${String(i).padStart(4, '0')}`, ['never-arrived'])));
    stageRaw(stage, [...flood, JSON.stringify(roll('good-1', [seed]))]);
    const candidates = bridge.readCandidates();
    expect(candidates).toHaveLength(1);
    expect(Object.keys(candidates[0].operations)).toEqual(['good-1']);
    bridge.admit(candidates[0]);
    expect(ws.getSnapshot().game.rolls).toHaveLength(1);
    expect(ws.getSnapshot().game.players).toEqual(before.game.players);
  });

  it('bounds admitted history at the operation limit, deterministically', () => {
    const { stage, ws, bridge } = setup();
    const seed = seedIdOf(ws);
    const flood = Array.from({ length: GAME_OPERATIONS + 10 }, (_, i) => JSON.stringify(roll(`wide-${String(i).padStart(5, '0')}`, [seed])));
    stageRaw(stage, flood);
    const candidates = bridge.readCandidates();
    expect(candidates).toHaveLength(1);
    const total = Object.keys(candidates[0].seeds).length + Object.keys(candidates[0].operations).length;
    expect(total).toBeLessThanOrEqual(GAME_OPERATIONS);
    bridge.admit(candidates[0]);
    const history = ws.getHistory();
    expect(Object.keys(history.seeds).length + Object.keys(history.operations).length).toBeLessThanOrEqual(GAME_OPERATIONS);
    // Truncation is deterministic: the excluded operations are the highest-sorted ids.
    expect(history.operations['wide-00000']).toBeDefined();
    expect(history.operations[`wide-${String(GAME_OPERATIONS + 9).padStart(5, '0')}`]).toBeUndefined();
  });

  it('admit fails closed on a foreign game without touching the accepted snapshot', () => {
    const { ws, bridge } = setup();
    const before = ws.getSnapshot();
    const foreign = createTestWorkspace('foreign', { ...fixtureRoster(), id: 'other-game' });
    expect(() => bridge.admit(foreign.getHistory())).toThrow(ValidationError);
    expect(() => bridge.admit(foreign.getHistory())).toThrow(/Wrong game ID/);
    expect(ws.getSnapshot()).toEqual(before);
    foreign.destroy();
  });

  it('admit fails closed on a history with a missing causal parent', () => {
    const { ws, bridge } = setup();
    const before = ws.getSnapshot();
    const orphan = roll('orphan-1', ['never-arrived']);
    const broken: GameHistory = { modelVersion: 1, gameId: 'game', seeds: ws.getHistory().seeds, operations: { [orphan.id]: orphan } };
    expect(() => bridge.admit(broken)).toThrow(/Missing causal parent/);
    expect(ws.getSnapshot()).toEqual(before);
  });

  it('publish is idempotent and never rewrites existing entries', () => {
    const { ws, bridge, stage } = setup();
    ws.applyLocal({ type: 'roll', playerId: 'alex', sides: 6 });
    bridge.publish(ws.getHistory());
    const size = stagedKeys(stage).length;
    bridge.publish(ws.getHistory());
    expect(stagedKeys(stage)).toHaveLength(size);
  });

  it('excludes foreign-game staging content from candidates', () => {
    const { stage, ws, bridge } = setup();
    const foreign = createTestWorkspace('foreign', { ...fixtureRoster(), id: 'other-game' });
    bridge.publish(foreign.getHistory());
    stageRaw(stage, [JSON.stringify(roll('good-1', [seedIdOf(ws)]))]);
    const candidates = bridge.readCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].gameId).toBe('game');
    expect(Object.keys(candidates[0].operations)).toEqual(['good-1']);
    foreign.destroy();
  });

  it('bounds the control log and refuses oversized control events', () => {
    const stage = new Y.Doc();
    const event = (n: number): MembershipEvent => ({ type: 'admission-request', id: `evt-${n}`, requesterId: `peer-${n}`, at: n });
    for (let n = 0; n < CONTROL_ENTRIES + 10; n++) writeControlEvent(stage, event(n));
    const events = readControlEvents(stage);
    expect(events.length).toBeLessThanOrEqual(CONTROL_ENTRIES);
    expect(events[events.length - 1]).toEqual(event(CONTROL_ENTRIES + 9));
    // A single oversized event cannot be trimmed into the byte bound: it is refused and the
    // prior log survives.
    const huge: MembershipEvent = { type: 'admission-request', id: 'x'.repeat(200_000), requesterId: 'peer', at: 0 };
    expect(() => writeControlEvent(stage, huge)).toThrow(ValidationError);
    expect(readControlEvents(stage).length).toBeGreaterThan(0);
    expect(stage.getArray(STAGE_CONTROL).length).toBeLessThanOrEqual(CONTROL_ENTRIES);
    stage.destroy();
  });

  it('bootstraps a workspace snapshot from staged history', () => {
    const { stage, ws, bridge } = setup();
    ws.applyLocal({ type: 'roll', playerId: 'alex', sides: 6 });
    bridge.publish(ws.getHistory());
    const history = readStagedHistory(stage, 'game');
    expect(history).not.toBeNull();
    const snapshot = snapshotFromHistory(history!);
    const runtime: Runtime = namedRuntime('boot');
    const loaded = createWorkspace(snapshot, runtime, 'replica-b');
    expect(loaded.replicaId).toBe('replica-b');
    expect(loaded.getSnapshot().game.rolls).toHaveLength(1);
    expect(Object.keys(loaded.getHistory().operations)).toEqual(Object.keys(history!.operations));
    loaded.destroy();
    // A wrong game id finds nothing to bootstrap from.
    expect(readStagedHistory(stage, 'other-game')).toBeNull();
  });
});
