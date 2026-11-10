import * as Y from 'yjs';
import {
  compareAudioTracks, validateAudioTrack, validateAudioTombstone, validatePlaybackCommand,
  type AudioTrack, type AudioTombstone, type PlaybackCommand,
} from '../game/audio';
import {
  chatImageBytes, chatMessageBytes, sortChatRecords, trimChatImages, trimChatMessages,
  validateChatImage, validateChatMessage, type ChatImage, type ChatMessage,
} from '../game/chat';
import { projectHistory, validateHistory, validateOperation } from '../game/history';
import type { GameHistory, GameOperation, WorkspaceSnapshot } from '../game/sync-types';
import type { Game, Role } from '../game/types';
import { check, id, validateGame } from '../game/validation';
import type { Workspace } from '../game/workspace';
import {
  AUDIO_COMMANDS, AUDIO_COMMAND_BYTES, AUDIO_TOMBSTONES, AUDIO_TRACKS, CHAT_RECORDS,
  CONTROL_BYTES, CONTROL_ENTRIES, ENCODED_OPERATION_BYTES, GAME_OPERATIONS, PENDING_ADMISSIONS,
} from '../network/limits';
import { validateMembershipEvent, type MembershipEvent } from './membership';

/**
 * The transient staging document is the untrusted boundary between the room and the
 * durable workspace. It carries transient records only, none of them saved:
 *
 * - `gather.entries`: candidate game records, one canonical JSON key per seed/operation
 *   (individual records, never one replaceable game blob), mirroring the workspace doc's
 *   entry scheme so immutable IDs are self-checking.
 * - `gather.control`: the bounded membership control log. The log is replayed to a
 *   (re)joining participant naturally, because joining syncs the whole document.
 * - `gather.intents`: bounded, deduplicated roster-addition and claim intents.
 * - `gather.claims`: claim confirmations written only by the priority participant.
 * - `gather.chat`: durable chat text mirrored to peers, one canonical JSON key per message.
 * - `gather.chat-live`: live-only image payloads; they never reach the workspace or a save.
 * - `gather.audio`: durable audio metadata mirrored to peers, one canonical JSON key per track.
 * - `gather.audio-tombstones`: durable audio deletions mirrored to peers, keyed by track id.
 * - `gather.audio-playback`: the bounded, live-only playback command log (never saved).
 *
 * Everything read back from staging is treated as malicious until validated: canonical
 * keys, normalized payloads, immutable IDs, allowed roots and size bounds are checked
 * before anything is admitted into the durable workspace.
 */
export const STAGE_ENTRIES = 'gather.entries';
export const STAGE_CONTROL = 'gather.control';
export const STAGE_INTENTS = 'gather.intents';
export const STAGE_CLAIMS = 'gather.claims';
export const STAGE_CHAT = 'gather.chat';
export const STAGE_CHAT_LIVE = 'gather.chat-live';
export const STAGE_AUDIO = 'gather.audio';
export const STAGE_AUDIO_TOMBSTONES = 'gather.audio-tombstones';
export const STAGE_AUDIO_PLAYBACK = 'gather.audio-playback';

const encoder = new TextEncoder();
const MiB = 1024 * 1024;
/**
 * Aggregate encoded bound for the transient staging document. Game history is admitted
 * first; staged chat and live images are the lowest-priority data and are pruned to make
 * room for it. The durable workspace keeps its own 1 MiB encoded cap.
 */
export const STAGE_BYTES = 1.75 * MiB;
const LIMIT_MESSAGE = 'Room data limit reached; the accepted game is unchanged — download a backup before continuing.';

export type WorkspaceBridge = {
  /**
   * Validated candidate histories assembled from staging, grouped per game. Operations whose
   * causal parents have not arrived stay in the staging doc (Task 4 contract: a pending id
   * carries no payload out of reconciliation; the payload remains caller-owned until its
   * dependencies arrive) and are excluded until their closure completes.
   */
  readCandidates(): GameHistory[];
  /** Mirrors a validated history into staging as individual canonical records. */
  publish(history: GameHistory): void;
  /** Validates and merges a history into the durable workspace; fails closed atomically. */
  admit(history: GameHistory): void;
  destroy(): void;
};

type StagedRecords = { seeds: Map<string, Game>; operations: Map<string, GameOperation> };

/**
 * Lenient per-record parse of the staging entries. A record survives only when it is
 * canonical JSON of its own normalized payload (so ID rewrites and tampered keys drop out)
 * and no other record claims the same immutable ID with a different payload (so conflicting
 * duplicates poison the ID instead of choosing a winner). Accepted workspace records are the
 * comparison baseline: a staged record that rewrites an accepted ID is poisoned, never merged.
 */
function parseRecords(stage: Y.Doc, knownSeeds?: Record<string, Game>, knownOperations?: Record<string, GameOperation>): StagedRecords {
  const seeds = new Map<string, Game>();
  const operations = new Map<string, GameOperation>();
  const poisonSeeds = new Set<string>();
  const poisonOperations = new Set<string>();
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const [key, marker] of stage.getMap(STAGE_ENTRIES)) {
    if (marker !== true) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(key); } catch { continue; }
    if (Array.isArray(parsed)) {
      if (parsed.length !== 2) continue;
      let seedId: string, game: Game;
      try { seedId = id(parsed[0]); game = validateGame(parsed[1]); } catch { continue; }
      const prior = seeds.get(seedId) ?? knownSeeds?.[seedId];
      if (poisonSeeds.has(seedId) || JSON.stringify([seedId, game]) !== key || (prior && !same(prior, game))) {
        poisonSeeds.add(seedId);
        seeds.delete(seedId);
        continue;
      }
      seeds.set(seedId, game);
    } else {
      let operation: GameOperation;
      try { operation = validateOperation(parsed); } catch { continue; }
      const prior = operations.get(operation.id) ?? knownOperations?.[operation.id];
      if (poisonOperations.has(operation.id) || JSON.stringify(operation) !== key || (prior && !same(prior, operation))) {
        poisonOperations.add(operation.id);
        operations.delete(operation.id);
        continue;
      }
      operations.set(operation.id, operation);
    }
  }
  return { seeds, operations };
}

type Closure = { seeds: Map<string, Game>; operations: Map<string, GameOperation> } | null;

/**
 * Builds the maximal causally closed, bounded record set for one game: seeds of that game
 * plus every staged operation whose parents resolve inside (anchors ∪ staged closure).
 * Operations with missing parents stay pending in staging; when more than
 * `MISSING_DEPENDENCY_OPERATIONS` of them accumulate, the overflow is rejected (excluded)
 * rather than allowed to grow. Cycles never resolve and are excluded the same way. The
 * result is truncated deterministically by (depth, id) to stay within `GAME_OPERATIONS`.
 */
function buildClosure(records: StagedRecords, gameId: string, anchorSeeds: ReadonlySet<string>, anchorOperations: ReadonlySet<string>, anchorCount: number): Closure {
  const stagedSeeds = new Map<string, Game>();
  for (const [seedId, game] of records.seeds) {
    if (game.id === gameId && !anchorSeeds.has(seedId)) stagedSeeds.set(seedId, game);
  }
  const known = new Set<string>([...anchorSeeds, ...anchorOperations, ...stagedSeeds.keys()]);
  const staged = [...records.operations.values()];
  const candidates = staged.filter(operation => !anchorOperations.has(operation.id));
  const byId = new Map(candidates.map(operation => [operation.id, operation]));
  const children = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const operation of candidates) {
    let missing = false, count = 0;
    for (const parent of operation.parents) {
      if (known.has(parent)) continue;
      if (byId.has(parent)) {
        count++;
        children.set(parent, [...(children.get(parent) ?? []), operation.id]);
      } else missing = true;
    }
    // Operations with a missing parent (or inside a cycle) never become ready: they stay
    // pending in the staging doc. Pending beyond MISSING_DEPENDENCY_OPERATIONS is rejected
    // overflow — either way it is excluded here and never reaches the durable workspace.
    if (!missing) indegree.set(operation.id, count);
  }
  const queue = candidates.filter(operation => indegree.get(operation.id) === 0);
  const ordered: GameOperation[] = [];
  const depth = new Map<string, number>();
  while (queue.length) {
    const operation = queue.shift()!;
    ordered.push(operation);
    depth.set(operation.id, 1 + Math.max(0, ...operation.parents.map(parent => depth.get(parent) ?? 0)));
    for (const childId of children.get(operation.id) ?? []) {
      const remaining = indegree.get(childId)! - 1;
      indegree.set(childId, remaining);
      if (remaining === 0) queue.push(byId.get(childId)!);
    }
  }
  let kept = ordered;
  const capacity = GAME_OPERATIONS - anchorCount - stagedSeeds.size;
  if (capacity <= 0) kept = [];
  else if (kept.length > capacity) {
    kept = [...kept].sort((a, b) => (depth.get(a.id)! - depth.get(b.id)!) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, capacity);
    // Truncation must not orphan survivors: drop anything whose parent was cut, until stable.
    const keptIds = new Set<string>([...known, ...kept.map(operation => operation.id)]);
    for (let changed = true; changed;) {
      changed = false;
      for (const operation of [...kept]) {
        if (operation.parents.every(parent => keptIds.has(parent))) continue;
        keptIds.delete(operation.id);
        kept.splice(kept.indexOf(operation), 1);
        changed = true;
      }
    }
  }
  // `null` means "nothing staged concerns this game"; records that merely echo anchored
  // content still yield the (unchanged) union so a published history round-trips.
  const gameSeeds = [...records.seeds.values()].some(game => game.id === gameId);
  const related = gameSeeds || kept.length > 0 || staged.some(operation => anchorOperations.has(operation.id));
  if (!related) return null;
  return { seeds: stagedSeeds, operations: new Map(kept.map(operation => [operation.id, operation])) };
}

/** Assembles one history from a closure plus anchors; returns null when nothing is staged. */
function assemble(gameId: string, closure: Closure, anchorSeeds: Record<string, Game>, anchorOperations: Record<string, GameOperation>): GameHistory | null {
  if (closure === null) return null;
  return validateHistory({
    modelVersion: 1,
    gameId,
    seeds: { ...anchorSeeds, ...Object.fromEntries(closure.seeds) },
    operations: { ...anchorOperations, ...Object.fromEntries(closure.operations) },
  });
}

/**
 * Reads a bootstrap history for one game from staging alone (no workspace anchor): the
 * validated seeds of that game plus their staged causal closure. Returns null until at
 * least one seed and its closure have arrived.
 */
export function readStagedHistory(stage: Y.Doc, gameId: string): GameHistory | null {
  check(id(gameId) === gameId, 'Invalid game ID.');
  const records = parseRecords(stage);
  const closure = buildClosure(records, gameId, new Set(), new Set(), 0);
  if (closure === null || closure.seeds.size === 0) return null;
  try {
    return assemble(gameId, closure, {}, {});
  } catch {
    return null;
  }
}

/** Encodes a validated history as a workspace snapshot with the canonical workspace layout. */
export function snapshotFromHistory(value: GameHistory): WorkspaceSnapshot {
  const history = validateHistory(value);
  const doc = new Y.Doc();
  try {
    doc.transact(() => {
      doc.getMap('meta').set('modelVersion', 1);
      doc.getMap('meta').set('gameId', history.gameId);
      for (const [seedId, game] of Object.entries(history.seeds)) doc.getMap('seeds').set(JSON.stringify([seedId, game]), true);
      for (const operation of Object.values(history.operations)) doc.getMap('operations').set(JSON.stringify(operation), true);
    });
    check(Y.encodeStateAsUpdate(doc).byteLength <= ENCODED_OPERATION_BYTES, 'History limit reached; download a backup.');
    return { game: projectHistory(history), history: Y.encodeStateAsUpdate(doc) };
  } finally {
    doc.destroy();
  }
}

/** Parses one staged chat record; malformed, noncanonical, or ID-mismatched records drop out. */
function stagedChatRecord(key: string, value: unknown): ChatMessage | null {
  if (typeof value !== 'string') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  let message: ChatMessage;
  try { message = validateChatMessage(parsed); } catch { return null; }
  return message.id === key && JSON.stringify(message) === value ? message : null;
}

function stagedChatRecords(stage: Y.Doc): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const [key, value] of stage.getMap(STAGE_CHAT)) {
    const message = stagedChatRecord(key, value);
    if (message) messages.push(message);
  }
  return sortChatRecords(messages);
}

/** Valid staged chat records, oldest first, bounded by the canonical retention. */
export function readStagedChat(stage: Y.Doc): ChatMessage[] {
  return trimChatMessages(stagedChatRecords(stage));
}

/** Parses one staged live image; malformed, noncanonical, or ID-mismatched records drop out. */
function stagedImageRecord(key: string, value: unknown): ChatImage | null {
  if (typeof value !== 'string') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  let image: ChatImage;
  try { image = validateChatImage(parsed); } catch { return null; }
  return image.id === key && JSON.stringify(image) === value ? image : null;
}

function stagedImages(stage: Y.Doc): ChatImage[] {
  const images: ChatImage[] = [];
  for (const [key, value] of stage.getMap(STAGE_CHAT_LIVE)) {
    const image = stagedImageRecord(key, value);
    if (image) images.push(image);
  }
  return sortChatRecords(images);
}

/** Valid staged live images, oldest first, bounded by the live retention. */
export function readLiveImages(stage: Y.Doc): ChatImage[] {
  return trimChatImages(stagedImages(stage));
}

type StageVictim = { map: Y.Map<unknown>; key: string; bytes: number };

/**
 * Frees space in the transient staging document by dropping the lowest-priority data:
 * invalid records first, then the oldest live images, then the oldest staged chat
 * records. Chat outside the newest `CHAT_RECORDS` window goes before the window itself,
 * so the canonical backlog survives while chat still yields to game history. Durable
 * game entries and the control log are never touched. Returns true once the encoded
 * stage is within `STAGE_BYTES`, and false when nothing else can be removed.
 */
export function shrinkTransientStage(stage: Y.Doc): boolean {
  let size = Y.encodeStateAsUpdate(stage).byteLength;
  if (size <= STAGE_BYTES) return true;
  const chat = stage.getMap(STAGE_CHAT);
  const live = stage.getMap(STAGE_CHAT_LIVE);
  const invalidChat: string[] = [], invalidImages: string[] = [];
  for (const [key, value] of chat) if (!stagedChatRecord(key, value)) invalidChat.push(key);
  for (const [key, value] of live) if (!stagedImageRecord(key, value)) invalidImages.push(key);
  if (invalidChat.length > 0 || invalidImages.length > 0) {
    stage.transact(() => {
      for (const key of invalidChat) chat.delete(key);
      for (const key of invalidImages) live.delete(key);
    });
    size = Y.encodeStateAsUpdate(stage).byteLength;
  }
  while (size > STAGE_BYTES) {
    const messages = stagedChatRecords(stage);
    const window = new Set(messages.slice(-CHAT_RECORDS).map(message => message.id));
    const victims: StageVictim[] = [
      ...stagedImages(stage).map(image => ({ map: live, key: image.id, bytes: chatImageBytes(image) })),
      ...messages.filter(message => !window.has(message.id)).map(message => ({ map: chat, key: message.id, bytes: chatMessageBytes(message) })),
      ...messages.filter(message => window.has(message.id)).map(message => ({ map: chat, key: message.id, bytes: chatMessageBytes(message) })),
    ];
    const excess = size - STAGE_BYTES;
    const chosen: StageVictim[] = [];
    let freed = 0;
    for (const victim of victims) {
      if (freed >= excess) break;
      chosen.push(victim);
      freed += victim.bytes;
    }
    if (chosen.length === 0) return false;
    stage.transact(() => { for (const victim of chosen) victim.map.delete(victim.key); });
    const next = Y.encodeStateAsUpdate(stage).byteLength;
    // Deletion must shrink the encoded document; otherwise a tombstone-only loop would spin.
    if (next >= size) return false;
    size = next;
  }
  return true;
}

/**
 * Mirrors canonical chat into staging, writing only records that are missing or differ.
 * This runs on every session refresh, so a matching stage is left byte-for-byte untouched.
 * On failure only our own writes are rolled back; anything `shrinkTransientStage` already
 * dropped as lowest-priority data stays dropped.
 */
export function publishChat(stage: Y.Doc, messages: readonly ChatMessage[]): void {
  const map = stage.getMap(STAGE_CHAT);
  const changes: Array<{ key: string; encoded: string; previous: string | undefined }> = [];
  for (const message of trimChatMessages(messages.map(value => validateChatMessage(value)))) {
    const encoded = JSON.stringify(message);
    const previous = map.get(message.id);
    if (previous === encoded) continue;
    changes.push({ key: message.id, encoded, previous: typeof previous === 'string' ? previous : undefined });
  }
  if (changes.length === 0) return;
  stage.transact(() => { for (const change of changes) map.set(change.key, change.encoded); });
  if (shrinkTransientStage(stage)) return;
  stage.transact(() => {
    for (const change of changes) {
      if (!map.has(change.key)) continue;
      if (change.previous === undefined) map.delete(change.key);
      else map.set(change.key, change.previous);
    }
  });
  check(false, LIMIT_MESSAGE);
}

/** Removes staged chat records outside the canonical keep set; a matching stage is untouched. */
export function pruneStagedChat(stage: Y.Doc, keep: readonly ChatMessage[]): void {
  const ids = new Set(keep.map(message => validateChatMessage(message).id));
  const map = stage.getMap(STAGE_CHAT);
  const stale = [...map.keys()].filter(key => !ids.has(key));
  if (stale.length === 0) return;
  stage.transact(() => { for (const key of stale) map.delete(key); });
}

/** Stages one live-only image, trimming older images; the bytes never reach the workspace. */
export function writeLiveImage(stage: Y.Doc, image: ChatImage): void {
  const validated = validateChatImage(image);
  const encoded = JSON.stringify(validated);
  const map = stage.getMap(STAGE_CHAT_LIVE);
  stage.transact(() => {
    if (map.get(validated.id) !== encoded) map.set(validated.id, encoded);
    const kept = new Set(trimChatImages(stagedImages(stage)).map(item => item.id));
    for (const key of [...map.keys()]) if (!kept.has(key)) map.delete(key);
  });
  if (shrinkTransientStage(stage)) return;
  if (map.has(validated.id)) stage.transact(() => map.delete(validated.id));
  check(false, LIMIT_MESSAGE);
}

/** Drops one live image; used to roll back an image whose durable caption was not saved. */
export function removeLiveImage(stage: Y.Doc, imageId: string): void {
  const map = stage.getMap(STAGE_CHAT_LIVE);
  if (!map.has(imageId)) return;
  stage.transact(() => map.delete(imageId));
}

/** Parses one staged audio track; malformed, noncanonical, or ID-mismatched records drop out. */
function stagedAudioTrack(key: string, value: unknown): AudioTrack | null {
  if (typeof value !== 'string') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  let track: AudioTrack;
  try { track = validateAudioTrack(parsed); } catch { return null; }
  return track.id === key && JSON.stringify(track) === value ? track : null;
}

/** Parses one staged audio tombstone; malformed, noncanonical, or ID-mismatched records drop out. */
function stagedAudioTombstone(key: string, value: unknown): AudioTombstone | null {
  if (typeof value !== 'string') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  let tombstone: AudioTombstone;
  try { tombstone = validateAudioTombstone(parsed); } catch { return null; }
  return tombstone.id === key && JSON.stringify(tombstone) === value ? tombstone : null;
}

/**
 * Valid staged audio metadata, deterministically ordered and bounded by the canonical
 * record limits. Invalid, noncanonical, or ID-rewritten records are skipped individually:
 * one malicious record never hides the rest. Sorting happens before the cap so every peer
 * keeps the same subset, and excess records are dropped here rather than thrown downstream.
 */
export function readStagedAudio(stage: Y.Doc): { tracks: AudioTrack[]; tombstones: AudioTombstone[] } {
  const tracks: AudioTrack[] = [];
  for (const [key, value] of stage.getMap(STAGE_AUDIO)) {
    const track = stagedAudioTrack(key, value);
    if (track) tracks.push(track);
  }
  const tombstones: AudioTombstone[] = [];
  for (const [key, value] of stage.getMap(STAGE_AUDIO_TOMBSTONES)) {
    const tombstone = stagedAudioTombstone(key, value);
    if (tombstone) tombstones.push(tombstone);
  }
  return {
    tracks: tracks.sort(compareAudioTracks).slice(0, AUDIO_TRACKS),
    tombstones: tombstones
      .sort((a, b) => (a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, AUDIO_TOMBSTONES),
  };
}

type StagedAudioChange = { map: Y.Map<unknown>; key: string; encoded: string; previous: string | undefined };

/**
 * Mirrors canonical audio metadata into staging, writing only records that are missing or
 * differ. Like chat, this runs on every session refresh, so a matching stage is left
 * byte-for-byte untouched. Changes are keyed by record id, so duplicate input ids settle on
 * the last value while still restoring the original staged value on rollback. On overflow
 * only our own writes are rolled back and chat/images are pruned first by
 * `shrinkTransientStage`; the accepted workspace is never touched.
 */
export function publishAudio(stage: Y.Doc, tracks: readonly AudioTrack[], tombstones: readonly AudioTombstone[]): void {
  const changes = new Map<Y.Map<unknown>, Map<string, StagedAudioChange>>();
  const addChange = (map: Y.Map<unknown>, key: string, encoded: string) => {
    let byId = changes.get(map);
    if (!byId) {
      byId = new Map();
      changes.set(map, byId);
    }
    const pending = byId.get(key);
    if (pending) {
      if (encoded === pending.previous) byId.delete(key);
      else pending.encoded = encoded;
      return;
    }
    const previous = map.get(key);
    if (previous === encoded) return;
    byId.set(key, { map, key, encoded, previous: typeof previous === 'string' ? previous : undefined });
  };
  const audio = stage.getMap(STAGE_AUDIO);
  for (const value of tracks) {
    const track = validateAudioTrack(value);
    addChange(audio, track.id, JSON.stringify(track));
  }
  const graves = stage.getMap(STAGE_AUDIO_TOMBSTONES);
  for (const value of tombstones) {
    const tombstone = validateAudioTombstone(value);
    addChange(graves, tombstone.id, JSON.stringify(tombstone));
  }
  const pending = [...changes.values()].flatMap(byId => [...byId.values()]);
  if (pending.length === 0) return;
  stage.transact(() => { for (const change of pending) change.map.set(change.key, change.encoded); });
  if (shrinkTransientStage(stage)) return;
  stage.transact(() => {
    for (const change of pending) {
      if (!change.map.has(change.key)) continue;
      if (change.previous === undefined) change.map.delete(change.key);
      else change.map.set(change.key, change.previous);
    }
  });
  check(false, LIMIT_MESSAGE);
}

/** Removes staged audio records outside the canonical keep sets; a matching stage is untouched. */
export function pruneStagedAudio(stage: Y.Doc, tracks: readonly AudioTrack[], tombstones: readonly AudioTombstone[]): void {
  const trackIds = new Set(tracks.map(value => validateAudioTrack(value).id));
  const tombstoneIds = new Set(tombstones.map(value => validateAudioTombstone(value).id));
  const audio = stage.getMap(STAGE_AUDIO);
  const staleTracks = [...audio.keys()].filter(key => !trackIds.has(key));
  const graves = stage.getMap(STAGE_AUDIO_TOMBSTONES);
  const staleTombstones = [...graves.keys()].filter(key => !tombstoneIds.has(key));
  if (staleTracks.length === 0 && staleTombstones.length === 0) return;
  stage.transact(() => {
    for (const key of staleTracks) audio.delete(key);
    for (const key of staleTombstones) graves.delete(key);
  });
}

/** Validates a playback command, reporting any rejection in the command's own vocabulary. */
function stagePlaybackCommand(value: PlaybackCommand): PlaybackCommand {
  try {
    return validatePlaybackCommand(value);
  } catch {
    check(false, 'Invalid playback command.');
  }
}

/**
 * Appends one validated playback command to the bounded live-only log. Commands are
 * transient events: only the newest `AUDIO_COMMANDS` are retained so a long session
 * cannot grow the stage without bound. An oversized command is refused before any write.
 */
export function writePlaybackCommand(stage: Y.Doc, command: PlaybackCommand): void {
  const encoded = JSON.stringify(stagePlaybackCommand(command));
  check(encoder.encode(encoded).byteLength <= AUDIO_COMMAND_BYTES, 'Playback command exceeds the room limit.');
  const array = stage.getArray(STAGE_AUDIO_PLAYBACK);
  stage.transact(() => {
    array.push([encoded]);
    while (array.length > AUDIO_COMMANDS) array.delete(0, 1);
  });
}

/** Valid playback commands in log order (oldest first); malformed entries are skipped. */
export function readPlaybackCommands(stage: Y.Doc): PlaybackCommand[] {
  const commands: PlaybackCommand[] = [];
  for (const item of stage.getArray(STAGE_AUDIO_PLAYBACK).toArray()) {
    if (typeof item !== 'string') continue;
    let parsed: unknown;
    try { parsed = JSON.parse(item); } catch { continue; }
    let command: PlaybackCommand;
    try { command = validatePlaybackCommand(parsed); } catch { continue; }
    if (JSON.stringify(command) === item) commands.push(command);
  }
  return commands.slice(-AUDIO_COMMANDS);
}

export function createWorkspaceBridge(stage: Y.Doc, workspace: Workspace): WorkspaceBridge {
  let destroyed = false;
  const ensureOpen = () => check(!destroyed, 'Bridge is closed.');
  return {
    readCandidates() {
      ensureOpen();
      const local = workspace.getHistory();
      const records = parseRecords(stage, local.seeds, local.operations);
      const anchorSeeds = new Set(Object.keys(local.seeds));
      const anchorOperations = new Set(Object.keys(local.operations));
      const closure = buildClosure(records, local.gameId, anchorSeeds, anchorOperations, anchorSeeds.size + anchorOperations.size);
      if (closure === null) return [];
      const history = assemble(local.gameId, closure, local.seeds, local.operations);
      return history === null ? [] : [history];
    },
    publish(history) {
      ensureOpen();
      const validated = validateHistory(history);
      const map = stage.getMap(STAGE_ENTRIES);
      const keys: string[] = [];
      for (const [seedId, game] of Object.entries(validated.seeds)) keys.push(JSON.stringify([seedId, game]));
      for (const operation of Object.values(validated.operations)) keys.push(JSON.stringify(operation));
      const added: string[] = [];
      stage.transact(() => { for (const key of keys) if (!map.has(key)) { map.set(key, true); added.push(key); } });
      if (added.length === 0) return;
      // Chat and live images are lowest priority: prune them before giving up on history.
      if (shrinkTransientStage(stage)) return;
      // Roll the offending records back; the accepted workspace is never touched.
      stage.transact(() => { for (const key of added) map.delete(key); });
      check(false, LIMIT_MESSAGE);
    },
    admit(history) {
      ensureOpen();
      const validated = validateHistory(history);
      const local = workspace.getHistory();
      check(validated.gameId === local.gameId, 'Wrong game ID.');
      for (const [seedId, game] of Object.entries(validated.seeds)) {
        const known = local.seeds[seedId];
        check(known === undefined || JSON.stringify(known) === JSON.stringify(game), 'Seed ID collision.');
      }
      for (const [operationId, operation] of Object.entries(validated.operations)) {
        const known = local.operations[operationId];
        check(known === undefined || JSON.stringify(known) === JSON.stringify(operation), 'Operation ID collision.');
      }
      workspace.accept(validated);
    },
    destroy() { destroyed = true; },
  };
}

const controlBytes = (array: Y.Array<unknown>) => array.toArray().reduce<number>((sum, item) => sum + encoder.encode(String(item)).byteLength + 1, 0);

/** Appends one validated control event to the bounded log; oversized events are refused. */
export function writeControlEvent(stage: Y.Doc, event: MembershipEvent): void {
  check(validateMembershipEvent(event) !== null, 'Invalid control event.');
  const encoded = JSON.stringify(event);
  check(encoder.encode(encoded).byteLength <= CONTROL_BYTES, LIMIT_MESSAGE);
  const array = stage.getArray(STAGE_CONTROL);
  stage.transact(() => {
    array.push([encoded]);
    while (array.length > CONTROL_ENTRIES) array.delete(0, 1);
    while (array.length > 0 && controlBytes(array) > CONTROL_BYTES) array.delete(0, 1);
  });
}

/** Reads every decodable, valid control event in log order; malformed entries are skipped. */
export function readControlEvents(stage: Y.Doc): MembershipEvent[] {
  const events: MembershipEvent[] = [];
  for (const item of stage.getArray(STAGE_CONTROL).toArray()) {
    if (typeof item !== 'string') continue;
    let parsed: unknown;
    try { parsed = JSON.parse(item); } catch { continue; }
    const event = validateMembershipEvent(parsed);
    if (event) events.push(event);
  }
  return events;
}

export type RosterIntent =
  | { id: string; type: 'add-player'; participantId: string; name: string; role: Role; at: number }
  | { id: string; type: 'claim'; participantId: string; playerId: string; at: number };

function validateIntent(value: unknown, key: string): RosterIntent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.id !== key) return null;
  if (typeof item.participantId !== 'string' || !item.participantId) return null;
  if (typeof item.at !== 'number' || !Number.isFinite(item.at)) return null;
  if (item.type === 'add-player') {
    if (Object.keys(item).some(field => !['id', 'type', 'participantId', 'name', 'role', 'at'].includes(field))) return null;
    if (typeof item.name !== 'string' || !item.name) return null;
    if (item.role !== 'gm' && item.role !== 'pj') return null;
    return { id: key, type: 'add-player', participantId: item.participantId, name: item.name, role: item.role, at: item.at };
  }
  if (item.type === 'claim') {
    if (Object.keys(item).some(field => !['id', 'type', 'participantId', 'playerId', 'at'].includes(field))) return null;
    if (typeof item.playerId !== 'string' || !item.playerId) return null;
    return { id: key, type: 'claim', participantId: item.participantId, playerId: item.playerId, at: item.at };
  }
  return null;
}

/** Validated pending intents, oldest first (deterministic across participants). */
export function readRosterIntents(stage: Y.Doc): RosterIntent[] {
  const intents: RosterIntent[] = [];
  for (const [key, value] of stage.getMap(STAGE_INTENTS)) {
    if (typeof value !== 'string') continue;
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { continue; }
    const intent = validateIntent(parsed, key);
    if (intent) intents.push(intent);
  }
  return intents.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function writeRosterIntent(stage: Y.Doc, intent: RosterIntent): void {
  const map = stage.getMap(STAGE_INTENTS);
  check(map.size < PENDING_ADMISSIONS, 'The room is busy with pending roster changes; try again shortly.');
  stage.transact(() => map.set(intent.id, JSON.stringify(intent)));
}

export function removeRosterIntent(stage: Y.Doc, intentId: string): void {
  stage.getMap(STAGE_INTENTS).delete(intentId);
}

export type ClaimConfirmation = { playerId: string; participantId: string; at: number };

export function readClaimConfirmations(stage: Y.Doc): ClaimConfirmation[] {
  const confirmations: ClaimConfirmation[] = [];
  for (const [playerId, value] of stage.getMap(STAGE_CLAIMS)) {
    if (typeof value !== 'string') continue;
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { continue; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const item = parsed as Record<string, unknown>;
    if (item.playerId !== playerId) continue;
    if (typeof item.participantId !== 'string' || !item.participantId) continue;
    if (typeof item.at !== 'number' || !Number.isFinite(item.at)) continue;
    if (Object.keys(item).some(field => !['playerId', 'participantId', 'at'].includes(field))) continue;
    confirmations.push({ playerId, participantId: item.participantId, at: item.at });
  }
  return confirmations;
}

export function writeClaimConfirmation(stage: Y.Doc, confirmation: ClaimConfirmation): void {
  stage.transact(() => stage.getMap(STAGE_CLAIMS).set(confirmation.playerId, JSON.stringify(confirmation)));
}

/**
 * Clears intents and claim confirmations; they are per-connection and must never replay.
 * Staged chat, live images, audio metadata, and the playback log survive a reconnect
 * within the same session.
 */
export function clearTransientStage(stage: Y.Doc): void {
  stage.transact(() => {
    const intents = stage.getMap(STAGE_INTENTS);
    for (const key of [...intents.keys()]) intents.delete(key);
    const claims = stage.getMap(STAGE_CLAIMS);
    for (const key of [...claims.keys()]) claims.delete(key);
    stage.getArray(STAGE_CONTROL).delete(0, stage.getArray(STAGE_CONTROL).length);
  });
}
