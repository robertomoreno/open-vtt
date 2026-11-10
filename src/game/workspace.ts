import * as Y from 'yjs';
import {
  AUDIO_METADATA_BYTES, AUDIO_TOMBSTONES, AUDIO_TRACKS,
  CHAT_HARD_RECORDS, ENCODED_OPERATION_BYTES, GAME_OPERATIONS,
} from '../network/limits';
import type { Game, Runtime } from './types';
import type { GameHistory, GameOperation, LocalEdit, WorkspaceSnapshot } from './sync-types';
import { trimChatMessages, validateChatMessage, type ChatMessage } from './chat';
import {
  audioTrackBytes, compareAudioTracks, mergeAudioTombstone, mergeAudioTrack,
  validateAudioTombstone, validateAudioTrack, type AudioTombstone, type AudioTrack,
} from './audio';
import { frontier, mergeHistory, projectHistory, validateHistory, validateOperation } from './history';
import { ValidationError, check, id, object, role, sides, text, timestamp, validateGame } from './validation';

export type Workspace = {
  readonly replicaId: string;
  getMessages(): ChatMessage[];
  addMessage(message: ChatMessage): void;
  mergeMessages(messages: readonly ChatMessage[]): void;
  getTracks(): AudioTrack[];
  getTombstones(): AudioTombstone[];
  addTrack(track: AudioTrack): void;
  mergeAudio(tracks: readonly AudioTrack[], tombstones: readonly AudioTombstone[]): void;
  setTrackGain(trackId: string, gain: number, by: string, at: string): void;
  removeTrack(trackId: string, by: string, at: string): void;
  getHistory(): GameHistory;
  getSnapshot(): WorkspaceSnapshot;
  applyLocal(edit: LocalEdit): void;
  accept(history: GameHistory): void;
  subscribe(fn: () => void): () => void;
  destroy(): void;
};

const AUDIO_KEYS = ['audio', 'audio-tombstones'];

function orderTracks(tracks: readonly AudioTrack[]): AudioTrack[] {
  return [...tracks].sort(compareAudioTracks);
}

function orderTombstones(tombstones: readonly AudioTombstone[]): AudioTombstone[] {
  return [...tombstones].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function metadataBytes(tracks: readonly AudioTrack[]): number {
  return tracks.reduce((total, track) => total + audioTrackBytes(track), 0);
}

/**
 * An id is content-addressed, so two records with the same `(addedAt, addedBy)` describe
 * the same upload event: the first active record keeps its cosmetic fields even when a
 * duplicate copy renames it. Records from distinct uploads defer to the canonical
 * `(addedAt, addedBy, canonical JSON)` ordering in `mergeAudioTrack`. Gain always follows
 * the newest edit.
 */
function mergeTrackRecords(existing: AudioTrack, incoming: AudioTrack): AudioTrack {
  const merged = mergeAudioTrack(existing, incoming);
  if (existing.addedAt !== incoming.addedAt || existing.addedBy !== incoming.addedBy) return merged;
  return {
    ...merged,
    name: existing.name,
    type: existing.type,
    size: existing.size,
    durationMs: existing.durationMs,
    addedAt: existing.addedAt,
    addedBy: existing.addedBy,
  };
}

function readDoc(doc: Y.Doc): GameHistory {
  check([...doc.share.keys()].every(key => ['meta', 'seeds', 'operations', 'chat', ...AUDIO_KEYS].includes(key)), 'Unexpected workspace data.');
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
type AudioState = { tracks: AudioTrack[]; tombstones: AudioTombstone[] };
function readAudio(doc: Y.Doc): AudioState {
  const audio = doc.getMap('audio'), stones = doc.getMap('audio-tombstones');
  check(stones.size <= AUDIO_TOMBSTONES, 'Too many audio tombstones.');
  const tombstones: AudioTombstone[] = [];
  for (const [key, value] of stones) {
    let tombstone: AudioTombstone;
    try {
      check(typeof value === 'string', 'Invalid audio tombstone.');
      tombstone = validateAudioTombstone(JSON.parse(value));
    } catch { throw new ValidationError('Invalid audio tombstone.'); }
    check(key === tombstone.id && JSON.stringify(tombstone) === value, 'Noncanonical audio tombstone.');
    tombstones.push(tombstone);
  }
  const removed = new Set(tombstones.map(tombstone => tombstone.id)), tracks: AudioTrack[] = [];
  for (const [key, value] of audio) {
    let track: AudioTrack;
    try {
      check(typeof value === 'string', 'Invalid audio record.');
      track = validateAudioTrack(JSON.parse(value));
    } catch { throw new ValidationError('Invalid audio record.'); }
    check(key === track.id && JSON.stringify(track) === value, 'Noncanonical audio record.');
    // Tombstones always win: a removed id never comes back from an old or merged record.
    if (!removed.has(track.id)) tracks.push(track);
  }
  check(tracks.length <= AUDIO_TRACKS, 'Too many audio tracks.');
  check(metadataBytes(tracks) <= AUDIO_METADATA_BYTES, 'Audio metadata limit reached.');
  return { tracks: orderTracks(tracks), tombstones: orderTombstones(tombstones) };
}
function loadSnapshot(value: WorkspaceSnapshot): { doc: Y.Doc; history: GameHistory; game: Game; messages: ChatMessage[]; tracks: AudioTrack[]; tombstones: AudioTombstone[] } {
  const snapshot = object(value, ['game', 'history']);
  const game = validateGame(snapshot.game);
  check(snapshot.history instanceof Uint8Array && snapshot.history.byteLength > 0 && snapshot.history.byteLength <= ENCODED_OPERATION_BYTES, 'Invalid or oversized history.');
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, snapshot.history);
    const history = readDoc(doc), projected = projectHistory(history), messages = readChat(doc), audio = readAudio(doc);
    const keep = new Set(messages.map(message => message.id));
    const chat = doc.getMap('chat');
    if ([...chat.keys()].some(key => !keep.has(key))) doc.transact(() => { for (const key of [...chat.keys()]) if (!keep.has(key)) chat.delete(key); });
    const keepTracks = new Set(audio.tracks.map(track => track.id)), audioMap = doc.getMap('audio');
    if ([...audioMap.keys()].some(key => !keepTracks.has(key))) doc.transact(() => { for (const key of [...audioMap.keys()]) if (!keepTracks.has(key)) audioMap.delete(key); });
    check(JSON.stringify(game) === JSON.stringify(projected), 'Snapshot does not match history.');
    check(Y.encodeStateAsUpdate(doc).byteLength <= ENCODED_OPERATION_BYTES, 'History limit reached; download a backup.');
    return { doc, history, game: projected, messages, tracks: audio.tracks, tombstones: audio.tombstones };
  } catch (error) { doc.destroy(); throw error; }
}
export function validateWorkspaceSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const loaded = loadSnapshot(snapshot);
  try { return { game: loaded.game, history: Y.encodeStateAsUpdate(loaded.doc) }; }
  finally { loaded.doc.destroy(); }
}

export function createWorkspace(input: Game | WorkspaceSnapshot, runtime: Runtime, replicaId?: string): Workspace {
  const author = id(replicaId ?? runtime.id());
  let doc: Y.Doc, history: GameHistory, game: Game, messages: ChatMessage[], tracks: AudioTrack[], tombstones: AudioTombstone[];
  if ('history' in input) {
    ({ doc, history, game, messages, tracks, tombstones } = loadSnapshot(input));
  } else {
    game = validateGame(input);
    const seedId = id(runtime.id());
    history = validateHistory({ modelVersion: 1, gameId: game.id, seeds: { [seedId]: game }, operations: {} });
    doc = new Y.Doc();
    doc.transact(() => { doc.getMap('meta').set('modelVersion', 1); doc.getMap('meta').set('gameId', game.id); doc.getMap('seeds').set(JSON.stringify([seedId, game]), true); });
    check(Y.encodeStateAsUpdate(doc).byteLength <= ENCODED_OPERATION_BYTES, 'History limit reached; download a backup.');
    messages = []; tracks = []; tombstones = [];
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
  function commitAudio(nextTracks: AudioTrack[], nextTombstones: AudioTombstone[]) {
    ensureOpen();
    // Audio is the lowest-priority durable data: refuse to shrink game history or chat for it.
    check(nextTracks.length <= AUDIO_TRACKS, 'Audio track limit reached.');
    check(nextTombstones.length <= AUDIO_TOMBSTONES, 'Audio tombstone limit reached.');
    check(metadataBytes(nextTracks) <= AUDIO_METADATA_BYTES, 'Audio metadata limit reached.');
    const previous = Y.encodeStateAsUpdate(doc), previousTracks = tracks, previousTombstones = tombstones;
    try {
      const keepTracks = new Set(nextTracks.map(track => track.id));
      const keepTombstones = new Set(nextTombstones.map(tombstone => tombstone.id));
      doc.transact(() => {
        const audio = doc.getMap('audio'), stones = doc.getMap('audio-tombstones');
        for (const key of [...audio.keys()]) if (!keepTracks.has(key)) audio.delete(key);
        for (const key of [...stones.keys()]) if (!keepTombstones.has(key)) stones.delete(key);
        for (const track of nextTracks) {
          const serialized = JSON.stringify(track);
          if (audio.get(track.id) !== serialized) audio.set(track.id, serialized);
        }
        for (const tombstone of nextTombstones) {
          const serialized = JSON.stringify(tombstone);
          if (stones.get(tombstone.id) !== serialized) stones.set(tombstone.id, serialized);
        }
      });
      check(Y.encodeStateAsUpdate(doc).byteLength <= ENCODED_OPERATION_BYTES, 'History limit reached; download a backup.');
      tracks = nextTracks; tombstones = nextTombstones;
    } catch (error) {
      doc.destroy(); doc = new Y.Doc(); Y.applyUpdate(doc, previous); tracks = previousTracks; tombstones = previousTombstones; throw error;
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
    getTracks() { ensureOpen(); return structuredClone(tracks); },
    getTombstones() { ensureOpen(); return structuredClone(tombstones); },
    addTrack(value) {
      ensureOpen();
      const track = validateAudioTrack(value);
      check(!tombstones.some(tombstone => tombstone.id === track.id), 'Audio track was removed.');
      // The first record for an ID wins; a duplicate add is a no-op, like a same-ID chat merge.
      if (tracks.some(existing => existing.id === track.id)) return;
      commitAudio(orderTracks([...tracks, track]), tombstones);
    },
    mergeAudio(incomingTracks, incomingTombstones) {
      ensureOpen();
      const mergedTracks = new Map(tracks.map(track => [track.id, track]));
      for (const value of incomingTracks) {
        const track = validateAudioTrack(value);
        const existing = mergedTracks.get(track.id);
        mergedTracks.set(track.id, existing === undefined ? track : mergeTrackRecords(existing, track));
      }
      const mergedTombstones = new Map(tombstones.map(tombstone => [tombstone.id, tombstone]));
      for (const value of incomingTombstones) {
        const tombstone = validateAudioTombstone(value);
        const existing = mergedTombstones.get(tombstone.id);
        mergedTombstones.set(tombstone.id, existing === undefined ? tombstone : mergeAudioTombstone(existing, tombstone));
      }
      for (const tombstoneId of mergedTombstones.keys()) mergedTracks.delete(tombstoneId);
      const nextTracks = orderTracks([...mergedTracks.values()]), nextTombstones = orderTombstones([...mergedTombstones.values()]);
      if (JSON.stringify(nextTracks) === JSON.stringify(tracks) && JSON.stringify(nextTombstones) === JSON.stringify(tombstones)) return;
      commitAudio(nextTracks, nextTombstones);
    },
    setTrackGain(trackId, gain, by, at) {
      ensureOpen();
      const key = id(trackId), index = tracks.findIndex(track => track.id === key);
      check(index !== -1, 'Unknown audio track.');
      const next = validateAudioTrack({ ...tracks[index], gain, gainAt: timestamp(at), gainBy: id(by) });
      const updated = [...tracks]; updated[index] = next;
      commitAudio(orderTracks(updated), tombstones);
    },
    removeTrack(trackId, by, at) {
      ensureOpen();
      const key = id(trackId);
      const tombstone = validateAudioTombstone({ id: key, at: timestamp(at), by: id(by) });
      const existing = tombstones.find(record => record.id === key);
      const nextTombstones = orderTombstones([
        ...tombstones.filter(record => record.id !== key),
        existing === undefined ? tombstone : mergeAudioTombstone(existing, tombstone),
      ]);
      const nextTracks = tracks.filter(track => track.id !== key);
      if (JSON.stringify(nextTracks) === JSON.stringify(tracks) && JSON.stringify(nextTombstones) === JSON.stringify(tombstones)) return;
      commitAudio(nextTracks, nextTombstones);
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
