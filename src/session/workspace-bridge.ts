import * as Y from 'yjs';
import { projectHistory, validateHistory, validateOperation } from '../game/history';
import type { GameHistory, GameOperation, WorkspaceSnapshot } from '../game/sync-types';
import type { Game, Role } from '../game/types';
import { check, id, validateGame } from '../game/validation';
import type { Workspace } from '../game/workspace';
import { CONTROL_BYTES, CONTROL_ENTRIES, ENCODED_OPERATION_BYTES, GAME_OPERATIONS, PENDING_ADMISSIONS } from '../network/limits';
import { validateMembershipEvent, type MembershipEvent } from './membership';

/**
 * The transient staging document is the untrusted boundary between the room and the
 * durable workspace. It carries four kinds of data, all transient and none of it saved:
 *
 * - `gather.entries`: candidate game records, one canonical JSON key per seed/operation
 *   (individual records, never one replaceable game blob), mirroring the workspace doc's
 *   entry scheme so immutable IDs are self-checking.
 * - `gather.control`: the bounded membership control log. The log is replayed to a
 *   (re)joining participant naturally, because joining syncs the whole document.
 * - `gather.intents`: bounded, deduplicated roster-addition and claim intents.
 * - `gather.claims`: claim confirmations written only by the priority participant.
 *
 * Everything read back from staging is treated as malicious until validated: canonical
 * keys, normalized payloads, immutable IDs, allowed roots and size bounds are checked
 * before anything is admitted into the durable workspace.
 */
export const STAGE_ENTRIES = 'gather.entries';
export const STAGE_CONTROL = 'gather.control';
export const STAGE_INTENTS = 'gather.intents';
export const STAGE_CLAIMS = 'gather.claims';

const encoder = new TextEncoder();
/** Aggregate encoded bound for the transient staging document (entries plus control log). */
const STAGE_BYTES = ENCODED_OPERATION_BYTES + CONTROL_BYTES;
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
      if (Y.encodeStateAsUpdate(stage).byteLength > STAGE_BYTES) {
        // Roll the offending records back; the accepted workspace is never touched.
        stage.transact(() => { for (const key of added) map.delete(key); });
        check(false, LIMIT_MESSAGE);
      }
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

/** Clears intents and claim confirmations; they are per-connection and must never replay. */
export function clearTransientStage(stage: Y.Doc): void {
  stage.transact(() => {
    const intents = stage.getMap(STAGE_INTENTS);
    for (const key of [...intents.keys()]) intents.delete(key);
    const claims = stage.getMap(STAGE_CLAIMS);
    for (const key of [...claims.keys()]) claims.delete(key);
    stage.getArray(STAGE_CONTROL).delete(0, stage.getArray(STAGE_CONTROL).length);
  });
}
