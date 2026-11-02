import { CAUSAL_PARENTS, GAME_OPERATIONS } from '../network/limits';
import type { Game, Player, Runtime } from './types';
import type { GameHistory, GameOperation, ResolutionPatch } from './sync-types';
import { check, id, integer, object, role, sides, text, validateGame, validatePlayer } from './validation';

function timestamp(value: unknown): string {
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'Invalid timestamp.');
  return value;
}
function ids(value: unknown): string[] {
  check(Array.isArray(value) && value.length <= CAUSAL_PARENTS, 'Invalid causal parents.');
  const result = value.map(id);
  check(new Set(result).size === result.length, 'Duplicate causal IDs.');
  return result;
}
function patch(value: unknown): ResolutionPatch {
  const item = object(value, ['type', 'name', 'playerId', 'role', 'player', 'roll', 'rollId']);
  switch (item.type) {
    case 'set-game-name': { const p = object(value, ['type', 'name']); return { type: item.type, name: text(p.name, 100) }; }
    case 'set-player-name': { const p = object(value, ['type', 'playerId', 'name']); return { type: item.type, playerId: id(p.playerId), name: text(p.name) }; }
    case 'set-player-role': { const p = object(value, ['type', 'playerId', 'role']); return { type: item.type, playerId: id(p.playerId), role: role(p.role) }; }
    case 'put-player': { const p = object(value, ['type', 'player']); return { type: item.type, player: validatePlayer(p.player) }; }
    case 'remove-player': { const p = object(value, ['type', 'playerId']); return { type: item.type, playerId: id(p.playerId) }; }
    case 'remove-roll': { const p = object(value, ['type', 'rollId']); return { type: item.type, rollId: id(p.rollId) }; }
    case 'put-roll': {
      const p = object(value, ['type', 'roll']);
      const r = object(p.roll, ['id', 'playerId', 'sides', 'value', 'at']);
      const die = sides(r.sides), result = integer(r.value, 1);
      check(result <= die, 'Invalid die result.');
      return { type: item.type, roll: { id: id(r.id), playerId: id(r.playerId), sides: die, value: result, at: timestamp(r.at) } };
    }
    default: throw new Error('Unsupported resolution patch.');
  }
}
export function validateOperation(value: unknown): GameOperation {
  const item = object(value, ['id', 'authorId', 'parents', 'at', 'type', 'name', 'playerId', 'role', 'player', 'sides', 'value', 'patches', 'candidateHeads', 'fallbackBase', 'fallbackFrontier', 'extendedResolutionIds']);
  const base = { id: id(item.id), authorId: id(item.authorId), parents: ids(item.parents), at: timestamp(item.at) };
  const fields = ['id', 'authorId', 'parents', 'at', 'type'];
  switch (item.type) {
    case 'set-game-name': object(value, [...fields, 'name']); return { ...base, type: item.type, name: text(item.name, 100) };
    case 'set-player-name': object(value, [...fields, 'playerId', 'name']); return { ...base, type: item.type, playerId: id(item.playerId), name: text(item.name) };
    case 'set-player-role': object(value, [...fields, 'playerId', 'role']); return { ...base, type: item.type, playerId: id(item.playerId), role: role(item.role) };
    case 'add-player': object(value, [...fields, 'player']); return { ...base, type: item.type, player: validatePlayer(item.player) };
    case 'roll': {
      object(value, [...fields, 'playerId', 'sides', 'value']);
      const die = sides(item.sides), result = integer(item.value, 1);
      check(result <= die, 'Invalid die result.');
      return { ...base, type: item.type, playerId: id(item.playerId), sides: die, value: result };
    }
    case 'resolution': {
      object(value, [...fields, 'patches', 'candidateHeads', 'fallbackBase', 'fallbackFrontier', 'extendedResolutionIds']);
      check(Array.isArray(item.patches) && item.patches.length > 0 && item.patches.length <= CAUSAL_PARENTS, 'Invalid resolution patches.');
      return { ...base, type: item.type, patches: item.patches.map(patch), candidateHeads: ids(item.candidateHeads), fallbackBase: ids(item.fallbackBase), fallbackFrontier: ids(item.fallbackFrontier), extendedResolutionIds: ids(item.extendedResolutionIds) };
    }
    default: throw new Error('Unsupported operation.');
  }
}

export function validateHistory(value: unknown): GameHistory {
  const h = object(value, ['modelVersion', 'gameId', 'seeds', 'operations']);
  check(h.modelVersion === 1, 'Unsupported history version.');
  const gameId = id(h.gameId);
  check(h.seeds !== null && typeof h.seeds === 'object' && !Array.isArray(h.seeds), 'Invalid seeds.');
  check(h.operations !== null && typeof h.operations === 'object' && !Array.isArray(h.operations), 'Invalid operations.');
  const seeds = Object.entries(h.seeds as Record<string, unknown>), operations = Object.entries(h.operations as Record<string, unknown>);
  check(seeds.length > 0 && seeds.length + operations.length <= GAME_OPERATIONS, 'History limit reached; download a backup before continuing.');
  const validatedSeeds: [string, Game][] = seeds.map(([key, value]) => {
    id(key); const game = validateGame(value); check(game.id === gameId, 'Wrong game ID.'); return [key, game];
  });
  const validatedOps: [string, GameOperation][] = operations.map(([key, value]) => {
    id(key); const operation = validateOperation(value); check(operation.id === key, 'Operation ID mismatch.'); return [key, operation];
  });
  const result = { modelVersion: 1 as const, gameId, seeds: Object.fromEntries(validatedSeeds), operations: Object.fromEntries(validatedOps) };
  orderedOperations(result);
  return result;
}

// Kahn's algorithm distinguishes a missing dependency from a fully present cycle.
export function orderedOperations(history: GameHistory): GameOperation[] {
  const seeds = new Set(Object.keys(history.seeds)), operations = new Map(Object.entries(history.operations));
  for (const key of operations.keys()) check(!seeds.has(key), 'Seed/operation ID collision.');
  const children = new Map<string, string[]>(), indegree = new Map<string, number>(), depth = new Map<string, number>();
  for (const [key, op] of operations) {
    let count = 0;
    for (const parent of op.parents) {
      check(seeds.has(parent) || operations.has(parent), `Missing causal parent: ${parent}`);
      if (operations.has(parent)) { count++; const list = children.get(parent) ?? []; list.push(key); children.set(parent, list); }
    }
    check(op.parents.length > 0, 'Missing causal parent.');
    indegree.set(key, count); depth.set(key, 1);
  }
  const ready = [...operations.keys()].filter(key => indegree.get(key) === 0), ordered: GameOperation[] = [];
  while (ready.length) {
    const key = ready.pop()!; ordered.push(operations.get(key)!);
    for (const child of children.get(key) ?? []) {
      depth.set(child, Math.max(depth.get(child)!, depth.get(key)! + 1));
      const count = indegree.get(child)! - 1; indegree.set(child, count); if (!count) ready.push(child);
    }
  }
  check(ordered.length === operations.size, 'Causal cycle.');
  for (const op of ordered) {
    if (op.type !== 'resolution') continue;
    const ancestors = new Set<string>(), pending = [...op.parents];
    while (pending.length) {
      const current = pending.pop()!;
      if (ancestors.has(current)) continue;
      ancestors.add(current);
      const parent = operations.get(current);
      if (parent) pending.push(...parent.parents);
    }
    for (const ref of [...op.candidateHeads, ...op.fallbackBase, ...op.fallbackFrontier, ...op.extendedResolutionIds]) {
      check(seeds.has(ref) || operations.has(ref), `Missing resolution evidence: ${ref}`);
      check(ancestors.has(ref), 'Resolution evidence must be causal history.');
    }
    for (const ref of op.extendedResolutionIds) check(operations.get(ref)?.type === 'resolution', 'Invalid extended resolution.');
  }
  return ordered.sort((a, b) => depth.get(a.id)! - depth.get(b.id)! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
export function frontier(history: GameHistory): string[] {
  const heads = new Set([...Object.keys(history.seeds), ...Object.keys(history.operations)]);
  for (const operation of Object.values(history.operations)) for (const parent of operation.parents) heads.delete(parent);
  const result = [...heads].sort();
  check(result.length <= CAUSAL_PARENTS, 'Causal frontier limit reached.');
  return result;
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
export function mergeHistory(base: GameHistory, incoming: GameHistory): GameHistory {
  const left = validateHistory(base), right = validateHistory(incoming);
  check(left.gameId === right.gameId, 'Wrong game ID.');
  const seeds = { ...left.seeds }, operations = { ...left.operations };
  for (const [key, game] of Object.entries(right.seeds)) {
    check(!Object.hasOwn(operations, key), 'ID collision.');
    if (Object.hasOwn(seeds, key)) check(same(seeds[key], game), 'Seed ID collision.'); else Object.defineProperty(seeds, key, { value: game, enumerable: true, configurable: true, writable: true });
  }
  for (const [key, op] of Object.entries(right.operations)) {
    check(!Object.hasOwn(seeds, key), 'ID collision.');
    if (Object.hasOwn(operations, key)) check(same(operations[key], op), 'Operation ID collision.'); else Object.defineProperty(operations, key, { value: op, enumerable: true, configurable: true, writable: true });
  }
  return validateHistory({ modelVersion: 1, gameId: left.gameId, seeds, operations });
}

export function projectHistory(value: GameHistory): Game {
  const history = validateHistory(value), seedKeys = Object.keys(history.seeds).sort();
  const seeds = seedKeys.map(key => history.seeds[key]);
  const first = seeds[0];
  const players = new Map(first.players.map(p => [p.id, { ...p }]));
  const rolls = new Map(first.rolls.map(r => [r.id, { ...r }]));
  for (const seed of seeds.slice(1)) {
    for (const player of seed.players) if (!players.has(player.id)) players.set(player.id, { ...player });
    for (const roll of seed.rolls) {
      const existing = rolls.get(roll.id); if (existing) check(same(existing, roll), 'Roll ID collision.'); else rolls.set(roll.id, { ...roll });
    }
  }
  let name = first.name, updatedAt = seeds.reduce((max, s) => s.updatedAt > max ? s.updatedAt : max, first.updatedAt);
  const apply = (p: ResolutionPatch) => {
    switch (p.type) {
      case 'set-game-name': name = p.name; break;
      case 'set-player-name': { const player = players.get(p.playerId); check(player, 'Unknown player reference.'); player.name = p.name; break; }
      case 'set-player-role': { const player = players.get(p.playerId); check(player, 'Unknown player reference.'); player.role = p.role; break; }
      case 'put-player': players.set(p.player.id, { ...p.player }); break;
      case 'remove-player': players.delete(p.playerId); break;
      case 'put-roll': { const old = rolls.get(p.roll.id); check(!old || same(old, p.roll), 'Roll ID collision.'); if (!old) rolls.set(p.roll.id, { ...p.roll }); break; }
      case 'remove-roll': rolls.delete(p.rollId); break;
    }
  };
  const operations = orderedOperations(history);
  for (const op of operations) {
    if (op.at > updatedAt) updatedAt = op.at;
    switch (op.type) {
      case 'set-game-name': case 'set-player-name': case 'set-player-role': apply(op); break;
      case 'add-player': check(!players.has(op.player.id), 'Duplicate player ID.'); apply({ type: 'put-player', player: op.player }); break;
      case 'roll': apply({ type: 'put-roll', roll: { id: op.id, playerId: op.playerId, sides: op.sides, value: op.value, at: op.at } }); break;
      case 'resolution': for (const p of op.patches) apply(p); break;
    }
  }
  // Validate all retained roll references, even those outside the visible last 100.
  for (const roll of rolls.values()) check(players.has(roll.playerId), 'Unknown roll player reference.');
  return validateGame({ ...first, name, updatedAt, revision: Math.max(...seeds.map(s => s.revision)) + operations.filter(op => op.type !== 'resolution').length, players: [...players.values()], rolls: [...rolls.values()].slice(-100) });
}
export function makeRosterAddition(history: GameHistory, player: Player, runtime: Runtime, authorId: string): GameOperation {
  const accepted = validateHistory(history);
  const operation = validateOperation({ type: 'add-player', id: runtime.id(), authorId, parents: frontier(accepted), at: runtime.now(), player });
  check(!Object.hasOwn(accepted.seeds, operation.id) && !Object.hasOwn(accepted.operations, operation.id), 'Operation ID collision.');
  const next = mergeHistory(accepted, { ...accepted, operations: { ...accepted.operations, [operation.id]: operation } });
  projectHistory(next);
  return operation;
}
