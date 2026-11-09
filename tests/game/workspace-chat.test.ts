import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { GameHistory, GameOperation, WorkspaceSnapshot } from '../../src/game/sync-types';
import type { ChatMessage } from '../../src/game/chat';
import { CHAT_RECORDS, ENCODED_OPERATION_BYTES } from '../../src/network/limits';
import { createWorkspace, validateWorkspaceSnapshot } from '../../src/game/workspace';
import { projectHistory, validateHistory, validateOperation } from '../../src/game/history';
import { createTestWorkspace, fixtureRoster, namedRuntime } from '../helpers/workspace';

const AT = '2026-11-09T10:00:00.000Z';
const message = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({ id, playerId: 'alex', at: AT, text: `Hello ${id}`, recipients: null, ...over });

function docOf(snapshot: WorkspaceSnapshot): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, snapshot.history);
  return doc;
}

// Builds a valid accepted snapshot whose encoded workspace is within a few bytes
// of the 1 MiB bound. The operation name length is measured in UTF-8 bytes so the
// final build lands on the cap instead of one whole operation short; every build
// is a single Y.Doc transaction, so the fixture costs a handful of encodes.
const sizedName = (bytes: number): string => '🧙'.repeat(Math.floor(bytes / 4)) + 'a'.repeat(bytes % 4);

function nearCapSnapshot(): WorkspaceSnapshot {
  const game = fixtureRoster(), seedId = 'cap-seed';
  let count = 1900, tail = 400;
  for (let attempt = 0; attempt < 12; attempt++) {
    const operations: Record<string, GameOperation> = {};
    let parents: string[] = [seedId];
    for (let i = 0; i < count; i++) {
      const id = `cap-${i}`;
      operations[id] = validateOperation({
        type: 'set-game-name', name: sizedName(i === count - 1 ? tail : 400), id, authorId: 'cap', parents, at: '2026-01-01T00:00:00.000Z',
      });
      parents = [id];
    }
    const history: GameHistory = validateHistory({ modelVersion: 1, gameId: game.id, seeds: { [seedId]: game }, operations });
    const doc = new Y.Doc();
    doc.transact(() => {
      doc.getMap('meta').set('modelVersion', 1);
      doc.getMap('meta').set('gameId', game.id);
      doc.getMap('seeds').set(JSON.stringify([seedId, game]), true);
      for (const operation of Object.values(operations)) doc.getMap('operations').set(JSON.stringify(operation), true);
    });
    const encoded = Y.encodeStateAsUpdate(doc), snapshot = { game: projectHistory(history), history: encoded };
    doc.destroy();
    const room = ENCODED_OPERATION_BYTES - encoded.byteLength;
    if (room >= 0 && room <= 10) return snapshot;
    const adjusted = tail + room - (room > 10 ? 8 : 0);
    if (adjusted > 400) { count += Math.ceil((adjusted - 400) / 520); tail = 400; }
    else if (adjusted < 1) { count -= Math.ceil((1 - adjusted) / 520); tail = 1; }
    else tail = adjusted;
  }
  throw new Error('Unable to build a near-cap workspace snapshot.');
}

describe('workspace chat', () => {
  it('saves and restores messages with the workspace snapshot', () => {
    const w = createTestWorkspace('a');
    w.addMessage(message('m1'));
    w.addMessage(message('m2', { recipients: ['alex', 'bea'] }));
    const restored = createWorkspace(w.getSnapshot(), namedRuntime('restored'));
    expect(restored.getMessages().map(m => m.id)).toEqual(['m1', 'm2']);
    expect(restored.getMessages()[1].recipients).toEqual(['alex', 'bea']);
  });

  it('keeps the newest 100 messages in the durable document', () => {
    const w = createTestWorkspace('a');
    for (let i = 0; i < CHAT_RECORDS + 1; i++) w.addMessage(message(`m${String(i).padStart(3, '0')}`, {
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }));
    expect(w.getMessages()).toHaveLength(CHAT_RECORDS);
    expect(w.getMessages()[0].id).toBe('m001');
    const doc = docOf(w.getSnapshot());
    expect(doc.getMap('chat').size).toBe(CHAT_RECORDS);
    doc.destroy();
  });

  it('merges new IDs, ignores same-ID rewrites, and only notifies on change', () => {
    const w = createTestWorkspace('a');
    let changes = 0;
    w.subscribe(() => changes++);
    w.addMessage(message('m1'));
    expect(changes).toBe(1);
    w.mergeMessages([message('m1', { text: 'Rewritten' }), message('m2')]);
    expect(w.getMessages().map(m => m.text)).toEqual(['Hello m1', 'Hello m2']);
    expect(changes).toBe(2);
    w.mergeMessages(w.getMessages());
    expect(changes).toBe(2);
  });

  it('normalizes a snapshot with more than 100 messages instead of rejecting it', () => {
    const base = createTestWorkspace('a');
    const doc = docOf(base.getSnapshot());
    doc.transact(() => {
      for (let i = 0; i < CHAT_RECORDS + 5; i++) {
        const m = message(`m${String(i).padStart(3, '0')}`, { at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
        doc.getMap('chat').set(m.id, JSON.stringify(m));
      }
    });
    const snapshot = { game: base.getSnapshot().game, history: Y.encodeStateAsUpdate(doc) };
    const validated = validateWorkspaceSnapshot(snapshot);
    const normalized = docOf(validated);
    expect(normalized.getMap('chat').size).toBe(CHAT_RECORDS);
    normalized.destroy();
    doc.destroy();
  });

  it('rejects invalid durable chat records', () => {
    const base = createTestWorkspace('a');
    const doc = docOf(base.getSnapshot());
    doc.transact(() => doc.getMap('chat').set('bad', '{"id":"bad"}'));
    const snapshot = { game: base.getSnapshot().game, history: Y.encodeStateAsUpdate(doc) };
    expect(() => validateWorkspaceSnapshot(snapshot)).toThrow(/chat/i);
    doc.destroy();
  });

  it('loads old snapshots without a chat map', () => {
    const w = createTestWorkspace('a');
    expect(w.getMessages()).toEqual([]);
    const restored = createWorkspace(w.getSnapshot(), namedRuntime('restored'));
    expect(restored.getMessages()).toEqual([]);
  });

  it('writes only changed chat records when committing a full backlog', () => {
    const w = createTestWorkspace('a');
    for (let i = 0; i < CHAT_RECORDS; i++) w.addMessage(message(`m${String(i).padStart(3, '0')}`, {
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }));
    const before = w.getSnapshot().history.byteLength;
    w.addMessage(message('extra', { at: new Date(Date.UTC(2026, 0, 1, 0, 2, 0)).toISOString() }));
    const growth = w.getSnapshot().history.byteLength - before;
    expect(w.getMessages()).toHaveLength(CHAT_RECORDS);
    expect(w.getMessages().at(-1)!.id).toBe('extra');
    expect(growth).toBeLessThan(1000);
  });

  it('rolls back a message when the encoded workspace would exceed its limit', () => {
    const w = createWorkspace(nearCapSnapshot(), namedRuntime('cap'), 'cap');
    let rejected = false;
    try { w.applyLocal({ type: 'set-game-name', name: '🏰'.repeat(100) }); } catch { rejected = true; }
    expect(rejected).toBe(true);
    const before = w.getSnapshot();
    expect(() => w.addMessage(message('m1'))).toThrow(/limit|backup/i);
    expect(w.getSnapshot()).toEqual(before);
    expect(w.getMessages()).toEqual([]);
  }, 120_000);
});
