import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { chatMessageBytes, type ChatMessage } from '../../src/game/chat';
import type { WorkspaceSnapshot } from '../../src/game/sync-types';
import { CHAT_RECORDS, ENCODED_OPERATION_BYTES } from '../../src/network/limits';
import { createWorkspace, validateWorkspaceSnapshot } from '../../src/game/workspace';
import { createTestWorkspace, namedRuntime, nearCapSnapshot } from '../helpers/workspace';

const AT = '2026-11-09T10:00:00.000Z';
const message = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({ id, playerId: 'alex', at: AT, text: `Hello ${id}`, recipients: null, ...over });

function docOf(snapshot: WorkspaceSnapshot): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, snapshot.history);
  return doc;
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

  it('rejects a message that cannot fit the encoded workspace and leaves it unchanged', () => {
    // ~1000 bytes of real headroom: enough for small messages, not a 2000-character one.
    const w = createWorkspace(nearCapSnapshot(1000), namedRuntime('cap'), 'cap');
    const before = w.getSnapshot();
    expect(w.getMessages()).toEqual([]);
    expect(() => w.addMessage(message('m1', { text: 'x'.repeat(2000) }))).toThrow(/could not be retained/i);
    expect(w.getSnapshot()).toEqual(before);
    expect(w.getMessages()).toEqual([]);
  }, 120_000);

  it('prunes the oldest other message before the new one when the workspace is tight', () => {
    const w = createWorkspace(nearCapSnapshot(2000), namedRuntime('cap'), 'cap');
    const headroom = ENCODED_OPERATION_BYTES - w.getSnapshot().history.byteLength;
    const old = message('old', { text: 'o'.repeat(Math.max(1, Math.floor(headroom / 2))) });
    const fresh = message('new', { text: 'n'.repeat(Math.max(1, Math.floor(headroom / 2))) });
    expect(chatMessageBytes(fresh)).toBeLessThan(headroom);
    expect(chatMessageBytes(old) + chatMessageBytes(fresh)).toBeGreaterThan(headroom);
    w.addMessage(old);
    w.addMessage(fresh);
    expect(w.getMessages().map(m => m.id)).toEqual(['new']);
  }, 120_000);

  it('rejects a message outside the newest-100 retention window', () => {
    const w = createTestWorkspace('a');
    for (let i = 0; i < CHAT_RECORDS; i++) w.addMessage(message(`m${String(i).padStart(3, '0')}`, {
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }));
    const before = w.getMessages();
    expect(() => w.addMessage(message('older', { at: '2025-01-01T00:00:00.000Z' }))).toThrow(/could not be retained/i);
    expect(w.getMessages()).toEqual(before);
  });
});
