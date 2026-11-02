// @vitest-environment jsdom
import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import { projectHistory } from '../../src/game/history';
import { capturePriority, reconcileHistories } from '../../src/game/reconcile';
import type { Game } from '../../src/game/types';
import type { WorkspaceSnapshot } from '../../src/game/sync-types';
import { createWorkspace } from '../../src/game/workspace';
import { downloadBackup, parseBackup, parseBackupFile, serializeBackup } from '../../src/storage/backups';
import { createTestWorkspace, fixtureRoster, forkTestWorkspace, namedRuntime } from '../helpers/workspace';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function encodeUpdate(gameId: string, seeds: Record<string, Game>, operations: unknown[]): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    doc.getMap('meta').set('modelVersion', 1);
    doc.getMap('meta').set('gameId', gameId);
    for (const [id, game] of Object.entries(seeds)) doc.getMap('seeds').set(JSON.stringify([id, game]), true);
    for (const op of operations) doc.getMap('operations').set(JSON.stringify(op), true);
  });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}
function wrap(game: Game, update: Uint8Array): string {
  return JSON.stringify({ format: 'gather-game', formatVersion: 2, game, history: { modelVersion: 1, encoding: 'base64', update: toBase64(update) } });
}

describe('portable backups', () => {
  const validObject = () => JSON.parse(serializeBackup(createTestWorkspace('saved').getSnapshot()));

  it('rejects an embedded snapshot inconsistent with the causal update', () => {
    const original = createTestWorkspace('saved').getSnapshot();
    const json = validObject();
    json.game.name = 'Different projection';
    expect(() => parseBackup(JSON.stringify(json), namedRuntime('import'))).toThrow();
    expect(parseBackup(serializeBackup(original), namedRuntime('good')).game).toEqual(original.game);
  });

  describe('outer schema', () => {
    it('rejects extra top-level keys', () => {
      const json = validObject();
      json.extra = true;
      expect(() => parseBackup(JSON.stringify(json), namedRuntime('r'))).toThrow();
    });
    it('rejects an unknown format', () => {
      const json = validObject();
      json.format = 'other';
      expect(() => parseBackup(JSON.stringify(json), namedRuntime('r'))).toThrow(/format/);
    });
    it('rejects an unsupported format version', () => {
      const json = validObject();
      json.formatVersion = 3;
      expect(() => parseBackup(JSON.stringify(json), namedRuntime('r'))).toThrow(/version/);
    });
    it('rejects an unsupported history model version', () => {
      const json = validObject();
      json.history.modelVersion = 2;
      expect(() => parseBackup(JSON.stringify(json), namedRuntime('r'))).toThrow(/version/);
    });
    it('rejects a non-base64 encoding', () => {
      const json = validObject();
      json.history.encoding = 'hex';
      expect(() => parseBackup(JSON.stringify(json), namedRuntime('r'))).toThrow(/encoding/);
    });
    it('rejects malformed base64', () => {
      const json = validObject();
      json.history.update = 'not base64!';
      expect(() => parseBackup(JSON.stringify(json), namedRuntime('r'))).toThrow(/base64/);
    });
    it('rejects extra history keys', () => {
      const json = validObject();
      json.history.extra = true;
      expect(() => parseBackup(JSON.stringify(json), namedRuntime('r'))).toThrow();
    });
    it('rejects a base64 blob that is not a valid Yjs update', () => {
      const json = validObject();
      json.history.update = toBase64(new Uint8Array([1, 2, 3, 4]));
      expect(() => parseBackup(JSON.stringify(json), namedRuntime('r'))).toThrow();
    });
  });

  describe('legacy import', () => {
    it('imports a legacy version-1 game and seeds it once', () => {
      const game = { ...fixtureRoster(), name: '日本語 🌿' };
      const snapshot = parseBackup(JSON.stringify(game), namedRuntime('legacy'));
      expect(snapshot.game).toEqual(game);
      const ws = createWorkspace(snapshot, namedRuntime('restored'));
      const history = ws.getHistory();
      ws.destroy();
      expect(Object.keys(history.seeds)).toHaveLength(1);
      expect(Object.keys(history.operations)).toHaveLength(0);
      expect(projectHistory(history)).toEqual(game);
    });
    it('rejects a legacy game over 1 MiB', () => {
      const game = { ...fixtureRoster(), name: 'x'.repeat(2 * 1024 * 1024) };
      expect(() => parseBackup(JSON.stringify(game), namedRuntime('r'))).toThrow(/1 MiB/);
    });
  });

  describe('size bounds', () => {
    it('rejects a backup JSON over 4 MiB before decoding', () => {
      const json = validObject();
      json.history.update = 'A'.repeat(5 * 1024 * 1024);
      expect(() => parseBackup(JSON.stringify(json), namedRuntime('r'))).toThrow(/large/i);
    });
    it('rejects a decoded history over 1 MiB before application', () => {
      const json = validObject();
      json.history.update = 'A'.repeat(4 * Math.ceil((1024 * 1024 + 1) / 3));
      expect(() => parseBackup(JSON.stringify(json), namedRuntime('r'))).toThrow(/large/i);
    });
  });

  describe('isolated document validation', () => {
    const game = () => fixtureRoster();
    it('rejects a missing causal parent', () => {
      const g = game();
      const update = encodeUpdate('game', { seed: g }, [
        { id: 'x-1', authorId: 'alice', parents: ['ghost'], at: g.createdAt, type: 'set-game-name', name: 'X' },
      ]);
      expect(() => parseBackup(wrap(g, update), namedRuntime('r'))).toThrow(/causal parent/);
    });
    it('rejects a causal cycle', () => {
      const g = game();
      const update = encodeUpdate('game', { seed: g }, [
        { id: 'a', authorId: 'alice', parents: ['b'], at: g.createdAt, type: 'set-game-name', name: 'A' },
        { id: 'b', authorId: 'alice', parents: ['a'], at: g.createdAt, type: 'set-game-name', name: 'B' },
      ]);
      expect(() => parseBackup(wrap(g, update), namedRuntime('r'))).toThrow(/cycle/);
    });
    it('rejects a reused operation ID with different contents', () => {
      const g = game();
      const update = encodeUpdate('game', { seed: g }, [
        { id: 'x-1', authorId: 'alice', parents: ['seed'], at: g.createdAt, type: 'set-game-name', name: 'One' },
        { id: 'x-1', authorId: 'alice', parents: ['seed'], at: g.createdAt, type: 'set-game-name', name: 'Two' },
      ]);
      expect(() => parseBackup(wrap(g, update), namedRuntime('r'))).toThrow(/collision/);
    });
  });

  it('retains losing candidates and resolutions across a roundtrip without session data', () => {
    const alice = createTestWorkspace('alice', { ...fixtureRoster(), name: 'Old Castle' });
    const bob = forkTestWorkspace(alice, 'bob'), carol = forkTestWorkspace(alice, 'carol');
    const priority = capturePriority(alice.getHistory(), alice.replicaId, 'tenure-1');
    bob.applyLocal({ type: 'set-game-name', name: 'Red Castle' });
    carol.applyLocal({ type: 'set-game-name', name: 'Blue Castle' });
    const result = reconcileHistories([alice.getHistory(), bob.getHistory(), carol.getHistory()], priority, namedRuntime('r'));
    alice.accept(result.history);
    const text = serializeBackup(alice.getSnapshot());
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed).sort()).toEqual(['format', 'formatVersion', 'game', 'history'].sort());
    expect(Object.keys(parsed.history).sort()).toEqual(['encoding', 'modelVersion', 'update'].sort());
    expect(Object.keys(parsed.game).sort()).toEqual(['createdAt', 'id', 'name', 'players', 'revision', 'rolls', 'schemaVersion', 'updatedAt'].sort());
    const ws = createWorkspace(parseBackup(text, namedRuntime('import')), namedRuntime('ws'));
    const history = ws.getHistory();
    ws.destroy();
    expect(Object.keys(history.operations)).toEqual(expect.arrayContaining(['bob-1', 'carol-1']));
    expect(Object.values(history.operations).some(op => op.type === 'resolution')).toBe(true);
    expect(projectHistory(history)).toEqual(result.game);
  });

  it('rejects snapshots carrying session or identity fields', () => {
    const snapshot = createTestWorkspace('saved').getSnapshot();
    expect(() => serializeBackup({ ...snapshot, membership: [] } as unknown as WorkspaceSnapshot)).toThrow();
    expect(() => serializeBackup({ game: { ...snapshot.game, secret: 'x' }, history: snapshot.history } as unknown as WorkspaceSnapshot)).toThrow();
  });

  it('checks actual UTF-8 byte length, not only File.size', async () => {
    const runtime = namedRuntime('r');
    const json = JSON.parse(serializeBackup(createTestWorkspace('saved').getSnapshot()));
    json.history.update = 'A'.repeat(5 * 1024 * 1024);
    await expect(parseBackupFile({ size: 10, text: async () => JSON.stringify(json) } as File, runtime)).rejects.toThrow(/large/i);
    const game = { ...fixtureRoster(), name: '日本語 🌿' };
    const snapshot = parseBackup(JSON.stringify(game), runtime);
    const text = serializeBackup(snapshot);
    const size = new TextEncoder().encode(text).length;
    await expect(parseBackupFile({ size, text: async () => text } as File, runtime)).resolves.toEqual(snapshot);
  });

  it('downloads a JSON backup and revokes its object URL even when the click throws', () => {
    const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
    vi.useFakeTimers();
    const revoke = vi.fn();
    URL.createObjectURL = () => 'blob:backup';
    URL.revokeObjectURL = revoke;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('blocked'); });
    try {
      const snapshot = createTestWorkspace('saved').getSnapshot();
      expect(() => downloadBackup(snapshot)).toThrow(/blocked/);
      expect(document.querySelector('a')).toBeNull();
      vi.runAllTimers();
      expect(revoke).toHaveBeenCalledWith('blob:backup');
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      click.mockRestore();
      vi.useRealTimers();
    }
  });
});
