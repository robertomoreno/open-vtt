import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { validateOperation } from '../../src/game/history';
import type { GameHistory, WorkspaceSnapshot } from '../../src/game/sync-types';
import type { DieSides, Game } from '../../src/game/types';
import { createWorkspace } from '../../src/game/workspace';
import { CAUSAL_PARENTS, EXPIRY_MS } from '../../src/network/limits';
import { createRoomLink } from '../../src/network/room-link';
import type { RoomTransport, RoomTransportView } from '../../src/network/room';
import { createPeerSession } from '../../src/session/peer';
import type { PeerSession } from '../../src/session/peer-types';
import { STAGE_ENTRIES } from '../../src/session/workspace-bridge';
import { createSessionHarness } from '../helpers/rooms';
import { namedRuntime } from '../helpers/workspace';

const AT = '2026-01-01T00:00:00.000Z';

function soloGame(): Game {
  return { schemaVersion: 1, id: 'game', name: 'Castle', createdAt: AT, updatedAt: AT, revision: 0, players: [{ id: 'alex', name: 'Alex', role: 'gm' }], rolls: [] };
}
function soloSnapshot(label: string): WorkspaceSnapshot {
  const ws = createWorkspace(soloGame(), namedRuntime(label), label);
  try { return ws.getSnapshot(); } finally { ws.destroy(); }
}
function twoGmGame(): Game {
  return { ...soloGame(), players: [
    { id: 'alex', name: 'Alex', role: 'gm' },
    { id: 'bea', name: 'Bea', role: 'gm' },
  ] };
}
function twoGmSnapshot(label: string): WorkspaceSnapshot {
  const ws = createWorkspace(twoGmGame(), namedRuntime(label), label);
  try { return ws.getSnapshot(); } finally { ws.destroy(); }
}
function forkSnapshot(source: WorkspaceSnapshot, label: string, name?: string): WorkspaceSnapshot {
  const ws = createWorkspace(source, namedRuntime(label), label);
  try { if (name) ws.applyLocal({ type: 'set-game-name', name }); return ws.getSnapshot(); } finally { ws.destroy(); }
}
function decodeHistory(snapshot: WorkspaceSnapshot): GameHistory {
  const ws = createWorkspace(snapshot, namedRuntime('decode'), 'decode');
  try { return ws.getHistory(); } finally { ws.destroy(); }
}
function offlineSession(label: string, opts: { initial?: WorkspaceSnapshot | null; remembered?: string | null; clock?: { at: number } } = {}): PeerSession {
  const clock = opts.clock ?? { at: 0 };
  return createPeerSession({
    initial: opts.initial === undefined ? soloSnapshot(label) : opts.initial,
    rememberedPlayerId: opts.remembered ?? null,
    runtime: namedRuntime(label),
    now: () => clock.at,
  });
}

describe('peer session', () => {
  it('rejects creation after losing the connection without queuing an addition', async () => {
    const h = createSessionHarness();
    const a = h.add('a', soloSnapshot('seed'), 'alex');
    const b = h.add('b', null);
    h.connect('a', 'b'); await h.flush();
    expect(a.getView().canCreatePlayer).toBe(true);
    h.disconnect('a');
    a.createPlayer('Bea', 'pj');
    expect(a.getView().game!.players).toHaveLength(1);
    expect(a.getView().error).toMatch(/connection/i);
    h.connect('a', 'b'); await h.flush();
    expect(a.getView().game!.players).toHaveLength(1);
    expect(b.getView().game!.players).toHaveLength(1);
    h.destroy();
  });

  it('pins signaling-only and presence-only states to canCreatePlayer false', () => {
    let clock = 0;
    const view: RoomTransportView = { phase: 'looking', openRtcConnections: 0, presence: [{ id: 'ghost', seenAt: clock }, { id: 'solo-1', seenAt: clock }], error: null };
    const fake: RoomTransport = { getView: () => view, subscribe: () => () => {}, close() { view.phase = 'closed'; } };
    const s = createPeerSession({ initial: soloSnapshot('seed'), rememberedPlayerId: 'alex', runtime: namedRuntime('solo'), now: () => clock, createTransport: () => fake });
    expect(s.openRoom()).not.toBeNull();
    expect(s.getView().phase).toBe('waiting');
    expect(s.getView().canCreatePlayer).toBe(false);
    s.createPlayer('Bea', 'pj');
    expect(s.getView().error).toBeTruthy();
    expect(s.getView().game!.players).toHaveLength(1);
    s.close();
  });

  it('pins not-yet-reconciled creation to canCreatePlayer false', async () => {
    const h = createSessionHarness();
    h.add('a', twoGmSnapshot('seed'), 'alex');
    const b = h.add('b', null, 'bea');
    h.connect('a', 'b');
    expect(b.getView().canCreatePlayer).toBe(false);
    expect(b.getView().phase).toBe('syncing');
    await h.flush();
    expect(b.getView().canCreatePlayer).toBe(true);
    h.destroy();
  });

  it('allows only the seated GM to add players', async () => {
    const h = createSessionHarness();
    const a = h.add('a', soloSnapshot('seed'), 'alex');
    const b = h.add('b', null);
    h.connect('a', 'b'); await h.flush();
    expect(b.getView().canCreatePlayer).toBe(false);
    b.createPlayer('Bea', 'pj');
    expect(b.getView().error).toMatch(/Only the GM/i);
    await h.flush();
    expect(a.getView().game!.players).toHaveLength(1);
    a.createPlayer('Bea', 'pj');
    await h.flush();
    expect(a.getView().game!.players.map(p => p.name)).toEqual(['Alex', 'Bea']);
    h.destroy();
  });

  it('counts admitted participants waiting for a character', async () => {
    const h = createSessionHarness();
    const a = h.add('a', soloSnapshot('seed'), 'alex');
    const b = h.add('b', null);
    h.connect('a', 'b'); await h.flush();
    expect(a.getView().unseatedParticipantCount).toBe(1);
    a.createPlayer('Bea', 'pj');
    await h.flush();
    const bea = a.getView().game!.players.find(p => p.name === 'Bea')!;
    b.selectPlayer(bea.id);
    await h.flush();
    expect(a.getView().unseatedParticipantCount).toBe(0);
    h.destroy();
  });

  it('keeps the last conflict notice until a new conflict replaces it', async () => {
    const h = createSessionHarness();
    const seed = soloSnapshot('seed');
    const a = h.add('a', seed, 'alex');
    const b = h.add('b', forkSnapshot(seed, 'b', 'Red Castle'));
    const c = h.add('c', forkSnapshot(seed, 'c', 'Blue Castle'));
    h.connect('a', 'b'); await h.flush();
    a.createPlayer('Bea', 'pj'); await h.flush();
    const bea = a.getView().game!.players.find(p => p.name === 'Bea')!;
    b.selectPlayer(bea.id); await h.flush();
    h.connect('a', 'c'); await h.flush();
    expect(a.getView().conflicts.length).toBeGreaterThan(0);
    a.createPlayer('Cy', 'pj'); await h.flush();
    const cy = a.getView().game!.players.find(p => p.name === 'Cy')!;
    c.selectPlayer(cy.id); await h.flush();
    expect(a.getView().conflicts.length).toBeGreaterThan(0);
    h.destroy();
  });

  it('yields exactly one player for a connected creation and a duplicate request', async () => {
    const h = createSessionHarness();
    const a = h.add('a', soloSnapshot('seed'), 'alex');
    const b = h.add('b', null);
    h.connect('a', 'b'); await h.flush();
    a.createPlayer('Bea', 'pj');
    a.createPlayer('Bea', 'pj');
    await h.flush();
    expect(a.getView().game!.players).toHaveLength(2);
    expect(b.getView().game!.players).toHaveLength(2);
    expect(b.getView().game!.players.map(p => p.name)).toEqual(['Alex', 'Bea']);
    // The addition is durably accepted, so a third request is a plain duplicate-name failure.
    a.createPlayer('Bea', 'pj');
    expect(a.getView().error).toMatch(/Duplicate/i);
    expect(a.getView().game!.players).toHaveLength(2);
    const history = decodeHistory(a.getSnapshot()!);
    const addition = Object.values(history.operations).find(op => op.type === 'add-player');
    expect(addition?.authorId).toBe('a-1');
    h.destroy();
  });

  it('rolls and edits for an existing player offline', () => {
    const s = offlineSession('solo', { remembered: 'alex' });
    const view = s.getView();
    expect(view.phase).toBe('local');
    expect(view.localPlayerId).toBe('alex');
    expect(view.canRoll).toBe(true);
    expect(view.canCreatePlayer).toBe(false);
    s.roll(6);
    s.edit({ type: 'set-game-name', name: 'Solo Castle' });
    const after = s.getView();
    expect(after.error).toBeNull();
    expect(after.game!.rolls).toHaveLength(1);
    expect(after.game!.name).toBe('Solo Castle');
    expect(after.saveGeneration).toBe(2);
    s.close();
  });

  it('never silently selects another player for missing or occupied remembered ids', async () => {
    const missing = offlineSession('ghost', { remembered: 'nobody' });
    expect(missing.getView().localPlayerId).toBeNull();
    expect(missing.getView().canRoll).toBe(false);
    missing.roll(6);
    expect(missing.getView().error).toBeTruthy();
    expect(missing.getView().game!.rolls).toHaveLength(0);
    missing.close();

    const h = createSessionHarness();
    const a = h.add('a', soloSnapshot('seed'), 'alex');
    const b = h.add('b', null, 'alex');
    h.connect('a', 'b'); await h.flush();
    // Both remembered the same player: the best-positioned claim is confirmed once.
    expect(a.getView().localPlayerId).toBe('alex');
    expect(b.getView().localPlayerId).toBeNull();
    expect(b.getView().canRoll).toBe(false);
    h.destroy();
  });

  it('auto-selects a valid available remembered id', () => {
    const s = offlineSession('solo', { remembered: 'alex' });
    expect(s.getView().localPlayerId).toBe('alex');
    s.close();
  });

  it('reclaims a remembered player after the leaving owner becomes unreachable', async () => {
    const h = createSessionHarness();
    const a = h.add('a', soloSnapshot('seed'), 'alex');
    const b = h.add('b', null);
    h.connect('a', 'b'); await h.flush();
    a.createPlayer('Bea', 'pj');
    await h.flush();
    const bea = a.getView().game!.players.find(player => player.name === 'Bea')!;

    b.selectPlayer(bea.id);
    await h.flush();
    expect(b.getView().localPlayerId).toBe(bea.id);
    expect(b.getView().onlinePlayerIds).toContain(bea.id);

    b.close();
    const c = h.add('c', null, bea.id);
    h.connect('a', 'c'); await h.flush();
    expect(c.getView().localPlayerId).toBe(bea.id);
    expect(c.getView().error).toBeNull();
    h.destroy();
  });

  it('confirms one owner per reconciled view for two concurrent claims', async () => {
    const h = createSessionHarness();
    const a = h.add('a', soloSnapshot('seed'));
    const b = h.add('b', null);
    h.connect('a', 'b'); await h.flush();
    a.selectPlayer('alex');
    b.selectPlayer('alex');
    await h.flush();
    expect(a.getView().localPlayerId).toBe('alex');
    expect(b.getView().localPlayerId).toBeNull();
    expect(a.getView().onlinePlayerIds).toEqual(['alex']);
    expect(b.getView().onlinePlayerIds).toEqual(['alex']);
    h.destroy();
  });

  it('keeps a disconnected existing-player selection local and rollable', async () => {
    const h = createSessionHarness();
    const a = h.add('a', soloSnapshot('seed'), 'alex');
    const b = h.add('b', null);
    h.connect('a', 'b'); await h.flush();
    a.disconnect();
    const view = a.getView();
    expect(view.phase).toBe('local');
    expect(view.localPlayerId).toBe('alex');
    expect(view.canRoll).toBe(true);
    expect(view.canCreatePlayer).toBe(false);
    a.roll(6);
    expect(a.getView().game!.rolls).toHaveLength(1);
    expect(a.getView().error).toBeNull();
    expect(a.getSnapshot()).not.toBeNull();
    h.destroy();
  });

  it('captures the successor’s current history, not an expired fallback, on priority loss', async () => {
    const h = createSessionHarness();
    h.add('a', soloSnapshot('seed'), 'alex');
    const b = h.add('b', null);
    h.connect('a', 'b'); await h.flush();
    expect(b.getView().priorityParticipantId).toBe('a-1');
    h.disconnect('b');
    // An offline edit only the successor holds.
    b.edit({ type: 'set-game-name', name: 'Bea Castle' });
    expect(b.getView().game!.name).toBe('Bea Castle');
    h.disconnect('a');
    h.advance(EXPIRY_MS + 1);
    expect(b.getView().priorityParticipantId).toBe('b-1');
    // Two competing renames from third-party authors land in the successor’s staging.
    const seed = Object.keys(decodeHistory(b.getSnapshot()!).seeds)[0];
    const rename = (id: string, authorId: string, name: string) => validateOperation({ type: 'set-game-name', id, authorId, parents: [seed], at: AT, name });
    h.stageOf('b').transact(() => {
      const map = h.stageOf('b').getMap(STAGE_ENTRIES);
      map.set(JSON.stringify(rename('x-1', 'x', 'X Castle')), true);
      map.set(JSON.stringify(rename('y-1', 'y', 'Y Castle')), true);
    });
    const view = b.getView();
    expect(view.error).toBeNull();
    expect(view.game!.name).toBe('Bea Castle');
    const history = decodeHistory(b.getSnapshot()!);
    const resolutions = Object.values(history.operations).filter(op => op.type === 'resolution');
    expect(resolutions).toHaveLength(1);
    const editOp = Object.values(history.operations).find(op => op.type === 'set-game-name' && op.authorId === 'b-1');
    expect(resolutions[0].fallbackFrontier).toContain(editOp!.id);
    expect(resolutions[0].authorId).toBe('b-1');
    h.destroy();
  });

  it('leaves the prior durable snapshot unchanged under malicious staging while valid operations survive', async () => {
    const h = createSessionHarness();
    const a = h.add('a', soloSnapshot('seed'), 'alex');
    const b = h.add('b', null);
    h.connect('a', 'b'); await h.flush();
    const seed = Object.keys(decodeHistory(a.getSnapshot()!).seeds)[0];
    const stage = h.stageOf('a');
    const scrambled = JSON.stringify({ type: 'roll', value: 3, id: 'sneaky', authorId: 'peer', playerId: 'alex', sides: 6, at: AT, parents: [seed] });
    const dupA = validateOperation({ type: 'roll', id: 'dup-1', authorId: 'peer', playerId: 'alex', sides: 6, value: 1, at: AT, parents: [seed] });
    const dupB = validateOperation({ type: 'roll', id: 'dup-1', authorId: 'peer', playerId: 'alex', sides: 6, value: 6, at: AT, parents: [seed] });
    const orphans = Array.from({ length: CAUSAL_PARENTS + 50 }, (_, i) => JSON.stringify(validateOperation({ type: 'roll', id: `orphan-${i}`, authorId: 'peer', playerId: 'alex', sides: 6, value: 2, at: AT, parents: ['never-arrived'] })));
    const good = validateOperation({ type: 'roll', id: 'good-1', authorId: 'peer', playerId: 'alex', sides: 20, value: 7, at: AT, parents: [seed] });
    stage.transact(() => {
      const map = stage.getMap(STAGE_ENTRIES);
      for (const key of ['{{{ not json', scrambled, JSON.stringify(dupA), JSON.stringify(dupB), ...orphans, JSON.stringify(good)]) map.set(key, true);
    });
    await h.flush();
    const view = a.getView();
    expect(view.game!.rolls).toHaveLength(1);
    expect(view.game!.rolls[0].sides).toBe(20);
    expect(view.game!.players).toHaveLength(1);
    // The valid independent operation was admitted everywhere.
    expect(b.getView().game!.rolls).toHaveLength(1);
    h.destroy();
  });

  it('freezes the pre-merge copy as the recovery snapshot before admitting a merge', async () => {
    const h = createSessionHarness();
    const snap = soloSnapshot('seed');
    const a = h.add('a', snap);
    const b = h.add('b', forkSnapshot(snap, 'b'), null);
    a.edit({ type: 'set-game-name', name: 'Ann Castle' });
    b.edit({ type: 'set-game-name', name: 'Bea Castle' });
    h.connect('a', 'b');
    const pre = a.getSnapshot()!;
    expect(a.getRecoverySnapshot()).toBeNull();
    await h.flush();
    const view = a.getView();
    expect(view.game!.name).toBe('Ann Castle');
    expect(view.conflicts.length).toBeGreaterThan(0);
    expect(view.conflicts[0].affected).toContain('game.name');
    expect(view.hasRecovery).toBe(true);
    const recovery = a.getRecoverySnapshot()!;
    expect(recovery.game).toEqual(pre.game);
    expect(recovery.history).toEqual(pre.history);
    expect(b.getView().game!.name).toBe('Ann Castle');
    h.destroy();
  });

  it('keeps merged state usable and downloadable after a wide merge blocks the next mutation', async () => {
    const h = createSessionHarness();
    const a = h.add('a', soloSnapshot('seed'), 'alex');
    const b = h.add('b', null);
    h.connect('a', 'b'); await h.flush();
    const seed = Object.keys(decodeHistory(a.getSnapshot()!).seeds)[0];
    const stage = h.stageOf('a');
    stage.transact(() => {
      const map = stage.getMap(STAGE_ENTRIES);
      for (let i = 0; i < CAUSAL_PARENTS + 1; i++) {
        map.set(JSON.stringify(validateOperation({ type: 'roll', id: `wide-${i}`, authorId: `wide-${i}`, playerId: 'alex', sides: 6, value: 3, at: AT, parents: [seed] })), true);
      }
    });
    a.getView();
    expect(a.getView().error).toBeNull();
    const generation = a.getView().saveGeneration;
    a.roll(6);
    const view = a.getView();
    expect(view.error).toMatch(/frontier|limit|download/i);
    expect(view.saveGeneration).toBe(generation);
    expect(a.getSnapshot()).not.toBeNull();
    expect(a.getRecoverySnapshot()).not.toBeNull();
    expect(decodeHistory(a.getSnapshot()!).operations['wide-0']).toBeDefined();
    h.destroy();
  });

  it('converges on identical accepted game and history after reorder, loss, rejoin and a late third participant', async () => {
    const h = createSessionHarness();
    const a = h.add('a', soloSnapshot('seed'), 'alex');
    const b = h.add('b', null);
    h.connect('a', 'b'); await h.flush();
    a.createPlayer('Bea', 'pj');
    await h.flush();
    const bea = b.getView().game!.players.find(p => p.name === 'Bea');
    expect(bea).toBeDefined();
    b.selectPlayer(bea!.id);
    await h.flush();
    b.roll(6);
    await h.flush();
    h.disconnect('b');
    const c = h.add('c', null);
    h.connect('a', 'c'); await h.flush();
    h.connect('a', 'b', 'c'); await h.flush();
    const [sa, sb, sc] = [a, b, c].map(s => s.getSnapshot());
    expect(sa).not.toBeNull(); expect(sb).not.toBeNull(); expect(sc).not.toBeNull();
    expect(sb!.game).toEqual(sa!.game);
    expect(sc!.game).toEqual(sa!.game);
    expect(decodeHistory(sb!)).toEqual(decodeHistory(sa!));
    expect(decodeHistory(sc!)).toEqual(decodeHistory(sa!));
    expect(sa!.game.players).toHaveLength(2);
    expect(sa!.game.rolls).toHaveLength(1);
    // The late participant learned the roster and tenure from the replayed control log.
    expect(c.getView().priorityParticipantId).toBe('a-1');
    expect(b.getView().priorityParticipantId).toBe('a-1');
    h.destroy();
  });

  it('fails safely on a wrong-game link and attaches existing local edits on a same-game link', async () => {
    const h = createSessionHarness();
    const snap = soloSnapshot('seed');
    const a = h.add('a', snap, 'alex');
    const foreign = createRoomLink('other-game');
    a.joinRoom(foreign);
    expect(a.getView().error).toMatch(/Wrong game ID/);
    expect(a.getView().phase).toBe('local');
    expect(a.getRoomLink()).toBeNull();
    expect(a.getSnapshot()).not.toBeNull();
    const b = h.add('b', forkSnapshot(snap, 'b', 'Bea Castle'), null);
    h.connect('a', 'b'); await h.flush();
    expect(a.getView().game!.name).toBe('Bea Castle');
    expect(b.getView().game!.name).toBe('Bea Castle');
    h.destroy();
  });

  it('rate-limits user actions without blocking sync', () => {
    const clock = { at: 0 };
    const s = offlineSession('solo', { remembered: 'alex', clock });
    for (let i = 0; i < 20; i++) s.roll(6);
    expect(s.getView().game!.rolls).toHaveLength(20);
    expect(s.getView().error).toBeNull();
    s.roll(6);
    expect(s.getView().error).toMatch(/Too many actions/i);
    expect(s.getView().game!.rolls).toHaveLength(20);
    expect(s.getView().saveGeneration).toBe(20);
    clock.at += 1000;
    s.roll(6);
    expect(s.getView().error).toBeNull();
    expect(s.getView().game!.rolls).toHaveLength(21);
    s.close();
  });

  it('bumps saveGeneration only for accepted workspace changes, per controller', async () => {
    const h = createSessionHarness();
    const a = h.add('a', soloSnapshot('seed'), 'alex');
    const b = h.add('b', null);
    expect(a.getView().saveGeneration).toBe(0);
    a.roll(7 as unknown as DieSides); // unsupported die: rejected, nothing accepted
    expect(a.getView().error).toBeTruthy();
    expect(a.getView().saveGeneration).toBe(0);
    a.roll(6);
    expect(a.getView().saveGeneration).toBe(1);
    expect(b.getView().saveGeneration).toBe(0);
    h.connect('a', 'b'); await h.flush();
    // The bootstrap plus the admitted merge are accepted changes for b only.
    expect(b.getView().saveGeneration).toBeGreaterThan(0);
    expect(a.getView().saveGeneration).toBe(1);
    h.destroy();
  });

  it('keeps room descriptors, control data and identity hints out of snapshots', async () => {
    const h = createSessionHarness();
    const a = h.add('a', soloSnapshot('seed'), 'alex');
    const b = h.add('b', null);
    h.connect('a', 'b'); await h.flush();
    a.roll(6);
    await h.flush();
    const snapshot = a.getSnapshot()!;
    expect(Object.keys(snapshot).sort()).toEqual(['game', 'history']);
    const link = a.getRoomLink()!;
    const serialized = JSON.stringify({ game: snapshot.game, view: a.getView(), recovery: a.getRecoverySnapshot()?.game ?? null });
    expect(serialized).not.toContain(link.secret);
    expect(serialized).not.toContain(link.roomId);
    expect(serialized).not.toContain('admission');
    expect(serialized).not.toContain('tenure');
    const history = decodeHistory(snapshot);
    const durableTypes = new Set(['set-game-name', 'set-player-name', 'set-player-role', 'add-player', 'roll', 'resolution']);
    expect(Object.values(history.operations).every(op => durableTypes.has(op.type))).toBe(true);
    h.destroy();
  });

  it('keeps the workspace on disconnect and destroys everything idempotently on close', async () => {
    const h = createSessionHarness();
    const a = h.add('a', soloSnapshot('seed'), 'alex');
    const b = h.add('b', null);
    h.connect('a', 'b'); await h.flush();
    a.disconnect();
    expect(a.getView().phase).toBe('local');
    expect(a.getSnapshot()).not.toBeNull();
    a.close();
    a.close();
    expect(a.getView().phase).toBe('closed');
    expect(a.getSnapshot()).toBeNull();
    expect(a.getRoomLink()).toBeNull();
    a.roll(6);
    a.createPlayer('Bea', 'pj');
    a.selectPlayer('alex');
    a.edit({ type: 'set-game-name', name: 'Nope' });
    a.joinRoom(createRoomLink('game'));
    expect(a.openRoom()).toBeNull();
    a.disconnect();
    expect(a.getView().error).toBeTruthy();
    expect(a.getView().phase).toBe('closed');
    h.destroy();
  });

  it('notifies subscribers on accepted changes', async () => {
    const h = createSessionHarness();
    const a = h.add('a', soloSnapshot('seed'), 'alex');
    const events: number[] = [];
    const unsubscribe = a.subscribe(() => events.push(a.getView().saveGeneration));
    a.roll(6);
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]).toBe(1);
    unsubscribe();
    a.roll(6);
    expect(events[events.length - 1]).toBe(1);
    h.destroy();
  });
});
