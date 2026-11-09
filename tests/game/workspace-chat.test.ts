import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { WorkspaceSnapshot } from '../../src/game/sync-types';
import type { ChatMessage } from '../../src/game/chat';
import { CHAT_RECORDS, ENCODED_OPERATION_BYTES } from '../../src/network/limits';
import { createWorkspace, validateWorkspaceSnapshot, type Workspace } from '../../src/game/workspace';
import { createTestWorkspace, namedRuntime } from '../helpers/workspace';

const AT = '2026-11-09T10:00:00.000Z';
const message = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({ id, playerId: 'alex', at: AT, text: `Hello ${id}`, recipients: null, ...over });

function docOf(snapshot: WorkspaceSnapshot): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, snapshot.history);
  return doc;
}

// Fills the encoded workspace until less than one chat-sized record fits. The
// name length is calibrated in UTF-8 bytes so the final accepted update lands
// within a few bytes of the 1 MiB bound instead of one whole operation short.
const sizedName = (bytes: number): string => '🧙'.repeat(Math.floor(bytes / 4)) + 'a'.repeat(bytes % 4);
const encodedSize = (w: Workspace): number => w.getSnapshot().history.byteLength;

function fillWorkspace(w: Workspace): boolean {
  let overhead = 120;
  for (let i = 0; i < 4095; i++) {
    const room = ENCODED_OPERATION_BYTES - encodedSize(w);
    if (room <= 25) {
      try { w.applyLocal({ type: 'set-game-name', name: '🏰'.repeat(100) }); } catch { return true; }
      return false;
    }
    const bytes = Math.max(1, Math.min(400, room - overhead - 8));
    const before = encodedSize(w);
    try { w.applyLocal({ type: 'set-game-name', name: sizedName(bytes) }); } catch { return false; }
    overhead = encodedSize(w) - before - bytes;
  }
  return false;
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

  it('rolls back a message when the encoded workspace would exceed its limit', () => {
    const w = createTestWorkspace('cap');
    const rejected = fillWorkspace(w);
    expect(rejected).toBe(true);
    const before = w.getSnapshot();
    expect(() => w.addMessage(message('m1'))).toThrow(/limit|backup/i);
    expect(w.getSnapshot()).toEqual(before);
    expect(w.getMessages()).toEqual([]);
  }, 120_000);
});
