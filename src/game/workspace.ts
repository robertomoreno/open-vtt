import * as Y from 'yjs';
import { CHAT_HARD_RECORDS, ENCODED_OPERATION_BYTES, GAME_OPERATIONS } from '../network/limits';
import type { Game, Runtime } from './types';
import type { GameHistory, GameOperation, LocalEdit, WorkspaceSnapshot } from './sync-types';
import { trimChatMessages, validateChatMessage, type ChatMessage } from './chat';
import { frontier, mergeHistory, projectHistory, validateHistory, validateOperation } from './history';
import { ValidationError, check, id, object, role, sides, text, validateGame } from './validation';

export type Workspace = {
  readonly replicaId: string;
  getMessages(): ChatMessage[];
  addMessage(message: ChatMessage): void;
  mergeMessages(messages: readonly ChatMessage[]): void;
  getHistory(): GameHistory;
  getSnapshot(): WorkspaceSnapshot;
  applyLocal(edit: LocalEdit): void;
  accept(history: GameHistory): void;
  subscribe(fn: () => void): () => void;
  destroy(): void;
};

function readDoc(doc: Y.Doc): GameHistory {
  check([...doc.share.keys()].every(key => ['meta', 'seeds', 'operations', 'chat'].includes(key)), 'Unexpected workspace data.');
  const meta = doc.getMap('meta');
  check([...meta.keys()].every(key => key === 'modelVersion' || key === 'gameId') && meta.size === 2, 'Invalid workspace metadata.');
  // The canonical content is the map key: different payloads with the same
  // semantic ID survive Yjs merging instead of silently choosing a key winner.
  const seeds: [string, Game][] = [], operations: [string, GameOperation][] = [];
  const seedIds = new Set<string>(), operationIds = new Set<string>();
  for (const [key, marker] of doc.getMap('seeds')) {
    check(marker === true, 'Invalid seed entry.');
    const entry: unknown = JSON.parse(key);
    check(Array.isArray(entry) && entry.length === 2, 'Invalid seed entry.');
    const seedId = id(entry[0]), game = validateGame(entry[1]);
    check(JSON.stringify([seedId, game]) === key, 'Noncanonical seed entry.');
    check(!seedIds.has(seedId), 'Seed ID collision.');
    seedIds.add(seedId); seeds.push([seedId, game]);
  }
  for (const [key, marker] of doc.getMap('operations')) {
    check(marker === true, 'Invalid operation entry.');
    const operation = validateOperation(JSON.parse(key));
    check(JSON.stringify(operation) === key, 'Noncanonical operation entry.');
    check(!operationIds.has(operation.id), 'Operation ID collision.');
    operationIds.add(operation.id); operations.push([operation.id, operation]);
  }
  return validateHistory({ modelVersion: meta.get('modelVersion'), gameId: meta.get('gameId'), seeds: Object.fromEntries(seeds), operations: Object.fromEntries(operations) });
}
function readChat(doc: Y.Doc): ChatMessage[] {
  const chat = doc.getMap('chat');
  check(chat.size <= CHAT_HARD_RECORDS, 'Too many chat records.');
  const records: ChatMessage[] = [];
  for (const [key, value] of chat) {
    let message: ChatMessage;
    try {
      check(typeof value === 'string', 'Invalid chat record.');
      message = validateChatMessage(JSON.parse(value));
    } catch { throw new ValidationError('Invalid chat record.'); }
    check(key === message.id && JSON.stringify(message) === value, 'Noncanonical chat record.');
    records.push(message);
  }
  return trimChatMessages(records);
}
function loadSnapshot(value: WorkspaceSnapshot): { doc: Y.Doc; history: GameHistory; game: Game; messages: ChatMessage[] } {
  const snapshot = object(value, ['game', 'history']);
  const game = validateGame(snapshot.game);
  check(snapshot.history instanceof Uint8Array && snapshot.history.byteLength > 0 && snapshot.history.byteLength <= ENCODED_OPERATION_BYTES, 'Invalid or oversized history.');
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, snapshot.history);
    const history = readDoc(doc), projected = projectHistory(history), messages = readChat(doc);
    const keep = new Set(messages.map(message => message.id));
    const chat = doc.getMap('chat');
    if ([...chat.keys()].some(key => !keep.has(key))) doc.transact(() => { for (const key of [...chat.keys()]) if (!keep.has(key)) chat.delete(key); });
    check(JSON.stringify(game) === JSON.stringify(projected), 'Snapshot does not match history.');
    check(Y.encodeStateAsUpdate(doc).byteLength <= ENCODED_OPERATION_BYTES, 'History limit reached; download a backup.');
    return { doc, history, game: projected, messages };
  } catch (error) { doc.destroy(); throw error; }
}
export function validateWorkspaceSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const loaded = loadSnapshot(snapshot);
  try { return { game: loaded.game, history: Y.encodeStateAsUpdate(loaded.doc) }; }
  finally { loaded.doc.destroy(); }
}

export function createWorkspace(input: Game | WorkspaceSnapshot, runtime: Runtime, replicaId?: string): Workspace {
  const author = id(replicaId ?? runtime.id());
  let doc: Y.Doc, history: GameHistory, game: Game, messages: ChatMessage[];
  if ('history' in input) {
    ({ doc, history, game, messages } = loadSnapshot(input));
  } else {
    game = validateGame(input);
    const seedId = id(runtime.id());
    history = validateHistory({ modelVersion: 1, gameId: game.id, seeds: { [seedId]: game }, operations: {} });
    doc = new Y.Doc();
    doc.transact(() => { doc.getMap('meta').set('modelVersion', 1); doc.getMap('meta').set('gameId', game.id); doc.getMap('seeds').set(JSON.stringify([seedId, game]), true); });
    check(Y.encodeStateAsUpdate(doc).byteLength <= ENCODED_OPERATION_BYTES, 'History limit reached; download a backup.');
    messages = [];
  }
  let destroyed = false;
  const listeners = new Set<() => void>();
  const ensureOpen = () => check(!destroyed, 'Workspace is closed.');
  const notify = () => { for (const listener of [...listeners]) listener(); };
  function commit(next: GameHistory, projected: Game) {
    ensureOpen();
    const previous = Y.encodeStateAsUpdate(doc);
    try {
      doc.transact(() => {
        const seeds = doc.getMap('seeds'), operations = doc.getMap('operations');
        for (const [key, seed] of Object.entries(next.seeds)) {
          const entry = JSON.stringify([key, seed]); if (!seeds.has(entry)) seeds.set(entry, true);
        }
        for (const operation of Object.values(next.operations)) {
          const entry = JSON.stringify(operation); if (!operations.has(entry)) operations.set(entry, true);
        }
      });
      check(Y.encodeStateAsUpdate(doc).byteLength <= ENCODED_OPERATION_BYTES, 'History limit reached; download a backup.');
    } catch (error) {
      doc.destroy(); doc = new Y.Doc(); Y.applyUpdate(doc, previous); throw error;
    }
    history = next; game = projected; notify();
  }
  function commitMessages(next: ChatMessage[], protectedId?: string) {
    ensureOpen();
    const previous = Y.encodeStateAsUpdate(doc), previousMessages = messages;
    try {
      const keep = new Set(next.map(message => message.id));
      doc.transact(() => {
        const chat = doc.getMap('chat');
        for (const key of [...chat.keys()]) if (!keep.has(key)) chat.delete(key);
        for (const message of next) {
          const serialized = JSON.stringify(message);
          if (chat.get(message.id) !== serialized) chat.set(message.id, serialized);
        }
      });
      const kept = [...next];
      while (Y.encodeStateAsUpdate(doc).byteLength > ENCODED_OPERATION_BYTES && kept.length > 0) {
        // The caller's new record is never a prune victim: drop the oldest *other* message
        // first, and fail rather than silently discard it when nothing else can go.
        const victim = kept.findIndex(message => message.id !== protectedId);
        check(victim !== -1, 'Chat message could not be retained.');
        const [oldest] = kept.splice(victim, 1);
        doc.transact(() => doc.getMap('chat').delete(oldest.id));
      }
      check(Y.encodeStateAsUpdate(doc).byteLength <= ENCODED_OPERATION_BYTES, 'History limit reached; download a backup.');
      check(protectedId === undefined || kept.some(message => message.id === protectedId), 'Chat message could not be retained.');
      messages = kept;
    } catch (error) {
      doc.destroy(); doc = new Y.Doc(); Y.applyUpdate(doc, previous); messages = previousMessages; throw error;
    }
    notify();
  }
  return {
    replicaId: author,
    getMessages() { ensureOpen(); return structuredClone(messages); },
    addMessage(value) {
      ensureOpen();
      const message = validateChatMessage(value);
      check(!messages.some(existing => existing.id === message.id), 'Duplicate chat message.');
      const next = trimChatMessages([...messages, message]);
      check(next.some(existing => existing.id === message.id), 'Chat message could not be retained.');
      commitMessages(next, message.id);
    },
    mergeMessages(incoming) {
      ensureOpen();
      const merged = new Map(messages.map(message => [message.id, message]));
      for (const value of incoming) {
        const message = validateChatMessage(value);
        if (!merged.has(message.id)) merged.set(message.id, message);
      }
      const next = trimChatMessages([...merged.values()]);
      if (JSON.stringify(next) !== JSON.stringify(messages)) commitMessages(next);
    },
    getHistory() { ensureOpen(); return structuredClone(history); },
    getSnapshot() { ensureOpen(); return { game: structuredClone(game), history: Y.encodeStateAsUpdate(doc) }; },
    applyLocal(edit) {
      ensureOpen();
      const e = object(edit, ['type', 'name', 'playerId', 'role', 'sides']);
      let payload: LocalEdit;
      switch (e.type) {
        case 'set-game-name': object(edit, ['type', 'name']); payload = { type: e.type, name: text(e.name, 100) }; break;
        case 'set-player-name': object(edit, ['type', 'playerId', 'name']); payload = { type: e.type, playerId: id(e.playerId), name: text(e.name) }; break;
        case 'set-player-role': object(edit, ['type', 'playerId', 'role']); payload = { type: e.type, playerId: id(e.playerId), role: role(e.role) }; break;
        case 'roll': object(edit, ['type', 'playerId', 'sides']); payload = { type: e.type, playerId: id(e.playerId), sides: sides(e.sides) }; break;
        default: throw new Error('Unsupported local edit.');
      }
      if ('playerId' in payload) check(game.players.some(player => player.id === payload.playerId), 'Unknown player reference.');
      check(Object.keys(history.seeds).length + Object.keys(history.operations).length < GAME_OPERATIONS, 'History limit reached; download a backup.');
      const operation = validateOperation({ ...payload, ...(payload.type === 'roll' ? { value: runtime.die(payload.sides) } : {}), id: runtime.id(), authorId: author, parents: frontier(history), at: runtime.now() });
      check(!Object.hasOwn(history.seeds, operation.id) && !Object.hasOwn(history.operations, operation.id), 'Operation ID collision.');
      const next = { ...history, operations: { ...history.operations, [operation.id]: operation } };
      commit(next, projectHistory(next));
    },
    accept(incoming) {
      ensureOpen();
      const next = mergeHistory(history, incoming), projected = projectHistory(next);
      if (JSON.stringify(next) !== JSON.stringify(history)) commit(next, projected);
    },
    subscribe(fn) { ensureOpen(); listeners.add(fn); return () => { listeners.delete(fn); }; },
    destroy() { if (!destroyed) { destroyed = true; listeners.clear(); doc.destroy(); } },
  };
}
