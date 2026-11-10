import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createAudioTrack, validatePlaybackCommand } from '../../src/game/audio';
import type { ChatImage, ChatMessage } from '../../src/game/chat';
import type { GameHistory, GameOperation } from '../../src/game/sync-types';
import type { Game, Runtime } from '../../src/game/types';
import { validateOperation } from '../../src/game/history';
import { ValidationError } from '../../src/game/validation';
import { createWorkspace, type Workspace } from '../../src/game/workspace';
import { AUDIO_COMMANDS, AUDIO_COMMAND_BYTES, CONTROL_ENTRIES, GAME_OPERATIONS, MISSING_DEPENDENCY_OPERATIONS } from '../../src/network/limits';
import {
  STAGE_AUDIO,
  STAGE_CHAT,
  STAGE_CONTROL,
  STAGE_ENTRIES,
  clearTransientStage,
  createWorkspaceBridge,
  pruneStagedAudio,
  pruneStagedChat,
  publishAudio,
  publishChat,
  readControlEvents,
  readLiveImages,
  readPlaybackCommands,
  readStagedAudio,
  readStagedChat,
  readStagedHistory,
  snapshotFromHistory,
  writeControlEvent,
  writeLiveImage,
  writePlaybackCommand,
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

describe('staged chat', () => {
  const AT = '2026-11-09T10:00:00.000Z';
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const msg = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({ id, playerId: 'alex', at: AT, text: `Hello ${id}`, recipients: null, ...over });
  const img = (id: string, over: Partial<ChatImage> = {}): ChatImage => ({ id, playerId: 'alex', at: AT, recipients: null, name: 'map.png', type: 'image/png', width: 1, height: 1, dataUrl: PNG, ...over });

  it('round-trips staged chat and skips malformed or noncanonical records', () => {
    const { stage } = setup();
    publishChat(stage, [msg('m1'), msg('m2')]);
    stage.transact(() => {
      stage.getMap(STAGE_CHAT).set('bad', '{"id":"bad"}');
      stage.getMap(STAGE_CHAT).set('rewrite', JSON.stringify(msg('other')));
    });
    expect(readStagedChat(stage).map(m => m.id)).toEqual(['m1', 'm2']);
    stage.transact(() => stage.getMap(STAGE_CHAT).set('m1', JSON.stringify(msg('m1', { text: 'tampered' }))));
    publishChat(stage, [msg('m1')]);
    expect(stage.getMap(STAGE_CHAT).get('m1')).toBe(JSON.stringify(msg('m1')));
    pruneStagedChat(stage, [msg('m2')]);
    expect([...stage.getMap(STAGE_CHAT).keys()]).toEqual(['m2']);
  });

  it('round-trips live images and trims the oldest beyond the bounds', () => {
    const { stage } = setup();
    for (let i = 0; i < 5; i++) writeLiveImage(stage, img(`i${i}`, { at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));
    expect(readLiveImages(stage).map(i => i.id)).toEqual(['i1', 'i2', 'i3', 'i4']);
    expect(readLiveImages(stage)[0].dataUrl).toBe(PNG);
  });

  it('prunes staged chat instead of rolling back a history publish', () => {
    const { stage, ws, bridge } = setup();
    const big = '🧙'.repeat(2000);
    stage.transact(() => {
      for (let i = 0; i < 400; i++) {
        const m = msg(`m${String(i).padStart(3, '0')}`, { text: big, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
        stage.getMap(STAGE_CHAT).set(m.id, JSON.stringify(m));
      }
    });
    expect(() => bridge.publish(ws.getHistory())).not.toThrow();
    expect(stage.getMap(STAGE_ENTRIES).size).toBeGreaterThan(0);
    expect(stage.getMap(STAGE_CHAT).size).toBeLessThan(400);
  });

  // Additional boundary checks beyond the plan's block: both stage writers must be true
  // no-ops when staging already matches, and a reconnect must not drop chat or images.
  it('writes only changed records and survives a transient-stage clear', () => {
    const { stage } = setup();
    publishChat(stage, [msg('m1')]);
    const staged = Y.encodeStateAsUpdate(stage);
    publishChat(stage, [msg('m1')]);
    pruneStagedChat(stage, [msg('m1')]);
    expect(Y.encodeStateAsUpdate(stage)).toEqual(staged);
    writeLiveImage(stage, img('i0'));
    const withImage = Y.encodeStateAsUpdate(stage);
    clearTransientStage(stage);
    expect(Y.encodeStateAsUpdate(stage)).toEqual(withImage);
    expect(readStagedChat(stage).map(m => m.id)).toEqual(['m1']);
    expect(readLiveImages(stage).map(i => i.id)).toEqual(['i0']);
  });

  it('still rolls back a history publish when game entries alone overflow the stage', () => {
    const { stage, ws, bridge } = setup();
    const seed = seedIdOf(ws);
    // An oversized candidate entry is game data: chat cannot make room for it, so the
    // publish must fail closed without leaving the new seed behind.
    stage.transact(() => stage.getMap(STAGE_ENTRIES).set(JSON.stringify([`junk-${'x'.repeat(2 * 1024 * 1024)}`, soloGame()]), true));
    const seedKey = JSON.stringify([seed, ws.getHistory().seeds[seed]]);
    expect(() => bridge.publish(ws.getHistory())).toThrow(/Room data limit/);
    expect(stage.getMap(STAGE_ENTRIES).has(seedKey)).toBe(false);
  });
});

describe('staged audio', () => {
  it('round-trips active tracks and tombstones and skips malformed records', () => {
    const { stage } = setup();
    const t = createAudioTrack({ id: 'a'.repeat(64), name: 'Theme.mp3', type: 'audio/mpeg', size: 1000, durationMs: 60_000 }, 'alex', AT);
    publishAudio(stage, [t], []);
    stage.transact(() => {
      stage.getMap(STAGE_AUDIO).set('bad', '{"id":"bad"}');
      stage.getMap(STAGE_AUDIO).set('rewrite', JSON.stringify({ ...t, id: 'b'.repeat(64) }));
    });
    expect(readStagedAudio(stage).tracks.map(x => x.id)).toEqual([t.id]);
    publishAudio(stage, [t], [{ id: t.id, at: AT, by: 'bea' }]);
    expect(readStagedAudio(stage).tombstones).toHaveLength(1);
  });

  it('prunes staged audio to the shared keep set without touching a matching stage', () => {
    const { stage } = setup();
    const t = createAudioTrack({ id: 'a'.repeat(64), name: 'Theme.mp3', type: 'audio/mpeg', size: 1000, durationMs: 60_000 }, 'alex', AT);
    publishAudio(stage, [t], []);
    const before = Y.encodeStateAsUpdate(stage);
    pruneStagedAudio(stage, [t], []);
    expect(Y.encodeStateAsUpdate(stage)).toEqual(before);
    pruneStagedAudio(stage, [], []);
    expect(readStagedAudio(stage).tracks).toEqual([]);
  });

  it('keeps a bounded playback command log and rejects oversized commands', () => {
    const { stage } = setup();
    const command = (rev: number) => validatePlaybackCommand({ id: `c${rev}`, rev, participantId: 'alex', trackId: 'a'.repeat(64), playing: true, positionMs: rev * 100, at: AT });
    for (let i = 0; i < AUDIO_COMMANDS + 5; i++) writePlaybackCommand(stage, command(i));
    const commands = readPlaybackCommands(stage);
    expect(commands).toHaveLength(AUDIO_COMMANDS);
    expect(commands[0].rev).toBe(5);
    expect(() => writePlaybackCommand(stage, { ...command(999), id: 'x'.repeat(AUDIO_COMMAND_BYTES) })).toThrow(/command/i);
  });

  it('survives a transient-stage clear and does not let audio overflow a history publish', () => {
    const { stage, ws, bridge } = setup();
    const t = createAudioTrack({ id: 'a'.repeat(64), name: 'Theme.mp3', type: 'audio/mpeg', size: 1000, durationMs: 60_000 }, 'alex', AT);
    publishAudio(stage, [t], []);
    writePlaybackCommand(stage, validatePlaybackCommand({ id: 'c1', rev: 1, participantId: 'alex', trackId: t.id, playing: false, positionMs: 0, at: AT }));
    clearTransientStage(stage);
    expect(readStagedAudio(stage).tracks).toHaveLength(1);
    expect(readPlaybackCommands(stage)).toHaveLength(1);
    expect(() => bridge.publish(ws.getHistory())).not.toThrow();
  });
});
