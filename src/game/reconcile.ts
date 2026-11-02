import { CAUSAL_PARENTS, GAME_OPERATIONS, MISSING_DEPENDENCY_OPERATIONS } from '../network/limits';
import type { Game, Player, Runtime } from './types';
import type { ConflictNotice, GameHistory, GameOperation, PriorityContext, Reconciliation, ResolutionPatch } from './sync-types';
import { frontier, projectHistory, validateHistory, validateOperation } from './history';
import { check, validateGame } from './validation';

type Resolution = Extract<GameOperation, { type: 'resolution' }>;
type Node = { id: string; seed?: Game; op?: GameOperation };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function sortedRecord<T>(entries: [string, T][]): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, value] of entries.sort(([a], [b]) => byId(a, b))) Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
  return result;
}
function hash(text: string): string {
  let h = 0x811c9dc5, g = 0x01000193;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); h = Math.imul(h ^ c, 0x01000193); g = Math.imul(g ^ c, 0x5bd1e995) ^ (g >>> 15); }
  return (h >>> 0).toString(16).padStart(8, '0') + (g >>> 0).toString(16).padStart(8, '0');
}

export function capturePriority(history: GameHistory, participantId: string, tenureId: string): PriorityContext {
  check(typeof participantId === 'string' && participantId.length > 0 && typeof tenureId === 'string' && tenureId.length > 0, 'Invalid priority context.');
  return { participantId, tenureId, baseline: structuredClone(validateHistory(history)) };
}

/** Values written by a node to each mutable register (`game.name`, `player:<id>.name|role`). */
function writes(node: Node): Map<string, string> {
  const result = new Map<string, string>();
  const player = (p: Player) => { result.set(`player:${p.id}.name`, p.name); result.set(`player:${p.id}.role`, p.role); };
  const patch = (p: ResolutionPatch | GameOperation) => {
    switch (p.type) {
      case 'set-game-name': result.set('game.name', p.name); break;
      case 'set-player-name': result.set(`player:${p.playerId}.name`, p.name); break;
      case 'set-player-role': result.set(`player:${p.playerId}.role`, p.role); break;
      case 'put-player': case 'add-player': player(p.player); break;
      case 'resolution': for (const item of p.patches) patch(item); break;
    }
  };
  if (node.seed) { result.set('game.name', node.seed.name); node.seed.players.forEach(player); }
  if (node.op) patch(node.op);
  return result;
}

/** Union candidates, keeping only complete, validated, collision-free causal closures. */
function collect(histories: readonly GameHistory[], baseline: GameHistory) {
  const gameId = baseline.gameId, seeds = new Map<string, Game>(), versions = new Map<string, GameOperation[]>(), rejected = new Set<string>();
  for (const history of [baseline, ...histories]) {
    check(history?.gameId === gameId, 'Wrong game ID.');
    for (const [key, value] of Object.entries(history.seeds ?? {})) {
      const game = validateGame(value);
      check(game.id === gameId, 'Wrong game ID.');
      const old = seeds.get(key); check(!old || same(old, game), 'Seed ID collision.');
      seeds.set(key, game);
    }
    for (const [key, value] of Object.entries(history.operations ?? {})) {
      let op: GameOperation;
      try { op = validateOperation(value); check(op.id === key, 'Operation ID mismatch.'); } catch { rejected.add(key); continue; }
      const list = versions.get(key) ?? [];
      if (!list.some(item => same(item, op))) list.push(op);
      versions.set(key, list);
    }
  }
  const ops = new Map<string, GameOperation>();
  for (const [key, list] of versions) {
    if (seeds.has(key)) { rejected.add(key); continue; }
    const kept = list.length === 1 ? list[0] : Object.hasOwn(baseline.operations, key) ? baseline.operations[key] : undefined;
    if (kept && !rejected.has(key)) ops.set(key, kept); else rejected.add(key);
  }
  for (;;) {
    const status = new Map<string, 'ok' | 'pending' | 'rejected' | 'visiting'>(), depth = new Map<string, number>();
    const visit = (key: string): 'ok' | 'pending' | 'rejected' => {
      if (seeds.has(key)) return 'ok';
      const known = status.get(key);
      if (known === 'visiting') return 'rejected';
      if (known) return known;
      if (rejected.has(key)) return 'rejected';
      const op = ops.get(key);
      if (!op) return 'pending';
      status.set(key, 'visiting');
      let result: 'ok' | 'pending' | 'rejected' = 'ok', d = 0;
      for (const parent of op.parents) {
        const s = visit(parent);
        if (s === 'rejected') result = 'rejected'; else if (s === 'pending' && result === 'ok') result = 'pending';
        d = Math.max(d, depth.get(parent) ?? 0);
      }
      status.set(key, result); depth.set(key, d + 1);
      return result;
    };
    for (const key of ops.keys()) visit(key);
    const pending = [...ops.keys()].filter(key => status.get(key) === 'pending').sort(byId);
    for (const key of [...ops.keys()]) if (status.get(key) === 'rejected') { rejected.add(key); ops.delete(key); }
    for (const key of pending.slice(MISSING_DEPENDENCY_OPERATIONS)) { rejected.add(key); ops.delete(key); }
    const accepted = [...ops.keys()].filter(key => status.get(key) === 'ok').sort((a, b) => depth.get(a)! - depth.get(b)! || byId(a, b));
    const nodes: Node[] = [...[...seeds.keys()].sort(byId).map(id => ({ id, seed: seeds.get(id)! })), ...accepted.map(id => ({ id, op: ops.get(id)! }))];
    const graph = new Graph(nodes);
    // Resolutions citing evidence outside their causal past are invalid; reject them and their descendants.
    const invalid = new Set<string>();
    for (const node of nodes) {
      const op = node.op;
      if (op?.type === 'resolution') {
        for (const ref of [...op.candidateHeads, ...op.fallbackBase, ...op.fallbackFrontier, ...op.extendedResolutionIds]) if (!graph.has(ref) || !graph.isAncestor(ref, op.id)) invalid.add(op.id);
        for (const ref of op.extendedResolutionIds) if (graph.node(ref)?.op?.type !== 'resolution') invalid.add(op.id);
      }
    }
    if (!invalid.size) return { gameId, seeds, nodes, graph, pending: pending.slice(0, MISSING_DEPENDENCY_OPERATIONS), rejected };
    for (const key of invalid) { rejected.add(key); ops.delete(key); }
  }
}

class Graph {
  private index = new Map<string, number>();
  private ancestors: Uint32Array[] = [];
  readonly authors: (string | undefined)[];
  readonly writes: Map<string, string>[];
  constructor(readonly nodes: Node[]) {
    const words = Math.ceil(nodes.length / 32) || 1;
    nodes.forEach((node, i) => this.index.set(node.id, i));
    for (const [i, node] of nodes.entries()) {
      const bits = new Uint32Array(words);
      for (const parent of node.op?.parents ?? []) {
        const p = this.index.get(parent)!;
        bits[p >>> 5] |= 1 << (p & 31);
        const inherited = this.ancestors[p];
        for (let w = 0; w < words; w++) bits[w] |= inherited[w];
      }
      this.ancestors[i] = bits;
    }
    this.authors = nodes.map(node => node.op?.authorId);
    this.writes = nodes.map(writes);
  }
  has(id: string) { return this.index.has(id); }
  idx(id: string) { return this.index.get(id)!; }
  node(id: string): Node | undefined { const i = this.index.get(id); return i === undefined ? undefined : this.nodes[i]; }
  /** Strict ancestry by index. */
  below(a: number, b: number) { return (this.ancestors[b][a >>> 5] & (1 << (a & 31))) !== 0; }
  isAncestor(a: string, b: string) { return this.has(a) && this.has(b) && this.below(this.idx(a), this.idx(b)); }
  /** Common inclusive ancestors of all given nodes as a bitset. */
  common(list: number[]): Uint32Array {
    const words = this.ancestors[0].length, result = new Uint32Array(words).fill(0xffffffff);
    for (const i of list) for (let w = 0; w < words; w++) result[w] &= this.ancestors[i][w] | (((i >>> 5) === w) ? 1 << (i & 31) : 0);
    return result;
  }
  members(mask: Uint32Array): number[] { const out: number[] = []; for (let i = 0; i < this.nodes.length; i++) if (mask[i >>> 5] & (1 << (i & 31))) out.push(i); return out; }
  maximal(list: number[]): number[] {
    const unique = [...new Set(list)];
    return unique.filter(a => !unique.some(b => b !== a && this.below(a, b))).sort((a, b) => byId(this.nodes[a].id, this.nodes[b].id));
  }
  /** Replace resolutions of a register by the leaf proposals they accounted for. */
  expand(list: number[], reg?: string, guard = 0): number[] {
    const out: number[] = [];
    for (const i of list) {
      const op = this.nodes[i].op;
      if (guard < 64 && op?.type === 'resolution' && (!reg || this.writes[i].has(reg))) {
        const candidates = op.candidateHeads.map(id => this.idx(id)).filter(c => !reg || this.writes[c].has(reg));
        const sub = this.expand(candidates, reg, guard + 1);
        out.push(...(sub.length ? sub : [i]));
      } else out.push(i);
    }
    return this.maximal(out);
  }
}

type Deferred = { id: string; kind: 'roll' | 'add' | 'player'; key: string };
/** Unvalidated projection mirroring `projectHistory`, reporting collisions no resolution accounts for yet. */
function materialize(history: GameHistory): { game: Game; deferred: Deferred[]; rollOwner: Map<string, string> } {
  const seedKeys = Object.keys(history.seeds).sort(byId), first = history.seeds[seedKeys[0]];
  const players = new Map<string, Player>(), rolls = new Map<string, Game['rolls'][number]>(), rollOwner = new Map<string, string>();
  const accounted = new Set<string>(), deferred: Deferred[] = [];
  for (const op of Object.values(history.operations)) if (op.type === 'resolution') op.candidateHeads.forEach(id => accounted.add(id));
  for (const key of seedKeys) {
    for (const p of history.seeds[key].players) if (!players.has(p.id)) players.set(p.id, { ...p });
    for (const r of history.seeds[key].rolls) {
      const old = rolls.get(r.id);
      if (!old) { rolls.set(r.id, { ...r }); rollOwner.set(r.id, key); } else if (!same(old, r)) deferred.push({ id: key, kind: 'roll', key: r.id });
    }
  }
  let name = first.name;
  const apply = (p: ResolutionPatch, owner: string) => {
    switch (p.type) {
      case 'set-game-name': name = p.name; break;
      case 'set-player-name': { const x = players.get(p.playerId); if (x) x.name = p.name; break; }
      case 'set-player-role': { const x = players.get(p.playerId); if (x) x.role = p.role; break; }
      case 'put-player': players.set(p.player.id, { ...p.player }); break;
      case 'remove-player': players.delete(p.playerId); break;
      case 'put-roll': if (!rolls.has(p.roll.id)) { rolls.set(p.roll.id, { ...p.roll }); rollOwner.set(p.roll.id, owner); } break;
      case 'remove-roll': rolls.delete(p.rollId); break;
    }
  };
  for (const { op } of orderOps(history)) {
    if (!op) continue;
    if (op.type === 'add-player') { if (players.has(op.player.id)) deferred.push({ id: op.id, kind: 'add', key: op.player.id }); else apply({ type: 'put-player', player: op.player }, op.id); }
    else if (op.type === 'set-player-name' || op.type === 'set-player-role') { if (players.has(op.playerId)) apply(op, op.id); else deferred.push({ id: op.id, kind: 'player', key: op.playerId }); }
    else if (op.type === 'roll') apply({ type: 'put-roll', roll: { id: op.id, playerId: op.playerId, sides: op.sides, value: op.value, at: op.at } }, op.id);
    else if (op.type === 'resolution') op.patches.forEach(p => apply(p, op.id));
    else apply(op, op.id);
  }
  return { game: { ...first, name, players: [...players.values()], rolls: [...rolls.values()] }, deferred: deferred.filter(d => !accounted.has(d.id)), rollOwner };
}
function orderOps(history: GameHistory): Node[] {
  const depth = new Map<string, number>();
  const visit = (key: string): number => {
    if (!Object.hasOwn(history.operations, key)) return 0;
    const known = depth.get(key); if (known !== undefined) return known;
    const d = 1 + Math.max(0, ...history.operations[key].parents.map(visit)); depth.set(key, d); return d;
  };
  return Object.keys(history.operations).sort((a, b) => visit(a) - visit(b) || byId(a, b)).map(id => ({ id, op: history.operations[id] }));
}

function describe(value: unknown): string { return typeof value === 'string' ? `“${value}”` : value === null ? 'nothing' : JSON.stringify(value); }

/**
 * `histories[0]` is this caller's current accepted local history; it only determines which
 * resolutions are new to this caller (and so produce notices). Later entries are unordered peer
 * candidates. Priority comes solely from `priority`, never from array order. Invalid baselines or
 * histories for another game fail closed; malformed operations are isolated in `rejectedIds`.
 * Inputs are never mutated.
 */
export function reconcileHistories(histories: readonly GameHistory[], priority: PriorityContext, runtime: Runtime): Reconciliation {
  check(Array.isArray(histories) && histories.length > 0, 'Nothing to reconcile.');
  const baseline = validateHistory(priority.baseline);
  const { gameId, nodes, graph, pending, rejected } = collect(histories, baseline);
  const baselineGame = projectHistory(baseline);
  const inBaseline = new Uint32Array(Math.ceil(nodes.length / 32) || 1);
  nodes.forEach((node, i) => { if (Object.hasOwn(baseline.seeds, node.id) || Object.hasOwn(baseline.operations, node.id)) inBaseline[i >>> 5] |= 1 << (i & 31); });
  const baselineValue = (reg: string): string | undefined => {
    if (reg === 'game.name') return baselineGame.name;
    const [, playerId, field] = /^player:(.*)\.(name|role)$/.exec(reg)!;
    const p = baselineGame.players.find(x => x.id === playerId);
    return p?.[field as 'name' | 'role'];
  };

  // Value held by a causal set: its register heads, recursively decided when they still compete.
  const valueIn = (reg: string, mask: Uint32Array, guard: number): string | undefined => {
    const heads = graph.maximal(graph.members(mask).filter(i => graph.writes[i].has(reg)));
    const values = [...new Set(heads.map(i => graph.writes[i].get(reg)!))];
    if (values.length <= 1) return values[0];
    return decide(reg, graph.expand(heads, reg), guard + 1).value;
  };
  function decide(reg: string, leaves: number[], guard = 0): { value: string; base: number[] } {
    const commonMask = graph.common(leaves), base = graph.maximal(graph.members(commonMask));
    const own = leaves.filter(i => graph.authors[i] === priority.participantId);
    if (own.length) return { value: graph.writes[own[0]].get(reg)!, base };
    const mask = commonMask.map((w, k) => w | inBaseline[k]);
    // A losing proposal shared by the branches is not the priority contribution: the
    // resolution that overruled it (seen by one branch) is the checkpoint for that group.
    const set = (m: Uint32Array, i: number) => (m[i >>> 5] & (1 << (i & 31))) !== 0;
    for (let changed = true; changed;) {
      changed = false;
      for (let r = 0; r < nodes.length; r++) {
        if (set(mask, r) || nodes[r].op?.type !== 'resolution' || !graph.writes[r].has(reg) || !leaves.some(l => graph.below(r, l))) continue;
        if (graph.expand([r], reg).some(c => c !== r && set(mask, c))) { mask[r >>> 5] |= 1 << (r & 31); changed = true; }
      }
    }
    const containsAll = leaves.every(i => mask[i >>> 5] & (1 << (i & 31)));
    const value = guard > 64 || containsAll ? baselineValue(reg) : valueIn(reg, mask, guard);
    return { value: value ?? baselineValue(reg) ?? graph.writes[leaves[0]].get(reg)!, base };
  }

  let history: GameHistory = {
    modelVersion: 1, gameId,
    seeds: sortedRecord(nodes.filter(n => n.seed).map(n => [n.id, n.seed!])),
    operations: sortedRecord(nodes.filter(n => n.op).map(n => [n.id, n.op!])),
  };
  const fallbackFrontier = frontier(baseline);
  // Causal lists are bounded, so a component whose evidence exceeds the bound is published as a chain:
  // each link cites the previous link plus the next bounded slice of evidence; the final link carries
  // the full fallback evidence (all causal ancestors through the chain). Parents are the cited evidence
  // only, never the whole frontier, which may itself exceed the bound.
  const publish = (patches: ResolutionPatch[], candidateHeads: number[], base: number[]) => {
    const heads = new Set(candidateHeads.map(i => nodes[i].id)), fallbackBase = base.map(i => nodes[i].id).sort(byId);
    check(fallbackBase.length <= CAUSAL_PARENTS, 'Conflict base exceeds the causal bound.');
    // Removed rolls must be projected before the patch that removes them.
    const removed = patches.flatMap(p => p.type === 'remove-roll' && Object.hasOwn(history.operations, p.rollId) ? [p.rollId] : []);
    const queue = [...new Set([...fallbackFrontier, ...fallbackBase, ...[...heads].sort(byId), ...removed.sort(byId)])];
    const chunks: ResolutionPatch[][] = [];
    for (let k = 0; k < patches.length; k += CAUSAL_PARENTS) chunks.push(patches.slice(k, k + CAUSAL_PARENTS));
    let link: string | undefined;
    for (let step = 0; queue.length || step < chunks.length; step++) {
      const taken = queue.splice(0, link ? CAUSAL_PARENTS - 1 : CAUSAL_PARENTS);
      const parents = [...(link ? [link] : []), ...taken].sort(byId);
      const cited = parents.filter(id => id === link || heads.has(id));
      const last = !queue.length;
      const op = validateOperation({
        type: 'resolution', id: runtime.id(), authorId: priority.participantId, parents, at: runtime.now(),
        patches: chunks[Math.min(step, chunks.length - 1)], candidateHeads: cited,
        fallbackBase: last ? fallbackBase : [], fallbackFrontier: last ? fallbackFrontier : [],
        extendedResolutionIds: cited.filter(id => (history.operations[id] ?? graph.node(id)?.op)?.type === 'resolution'),
      }) as Resolution;
      check(!Object.hasOwn(history.operations, op.id) && !Object.hasOwn(history.seeds, op.id), 'Operation ID collision.');
      history = { ...history, operations: { ...history.operations, [op.id]: op } };
      link = op.id;
    }
  };

  // Field conflicts: only competing register heads with different values.
  const registers = new Set<string>();
  for (const w of graph.writes) for (const reg of w.keys()) registers.add(reg);
  // Players created by more than one seed/operation are an indivisible invariant component.
  const creators = new Map<string, number[]>();
  nodes.forEach((node, i) => { for (const p of node.seed?.players ?? (node.op?.type === 'add-player' ? [node.op.player] : [])) creators.set(p.id, [...(creators.get(p.id) ?? []), i]); });
  const contested = new Set([...creators].filter(([, list]) => list.length > 1).map(([id]) => id));
  const all = new Uint32Array(inBaseline.length).fill(0xffffffff);
  for (const reg of [...registers].sort(byId)) {
    if (reg.startsWith('player:') && contested.has(reg.slice(7, reg.lastIndexOf('.')))) continue;
    const heads = graph.maximal(graph.members(all).filter(i => i < nodes.length && graph.writes[i].has(reg)));
    if (new Set(heads.map(i => graph.writes[i].get(reg))).size <= 1) continue;
    const { value, base } = decide(reg, graph.expand(heads, reg));
    const playerId = /^player:(.*)\.(name|role)$/.exec(reg);
    const patch: ResolutionPatch = !playerId ? { type: 'set-game-name', name: value }
      : playerId[2] === 'name' ? { type: 'set-player-name', playerId: playerId[1], name: value }
      : { type: 'set-player-role', playerId: playerId[1], role: value as Player['role'] };
    publish([patch], heads, base);
  }

  // Invariant components, one per round: legacy roll-ID collisions, duplicate player IDs, edits/rolls
  // depending on an absent player, duplicate names, then the roster bound. Retain the priority
  // version; withhold the rest with explicit patches so the proposals stay in history.
  const inMask = (m: Uint32Array, i: number) => (m[i >>> 5] & (1 << (i & 31))) !== 0;
  const upTo = (a: number, b: number) => a === b || graph.below(a, b);
  const baselineRoll = (rollId: string) => Object.values(baseline.seeds).flatMap(g => g.rolls).find(r => r.id === rollId)
    ?? Object.values(baseline.operations).flatMap(op => op.type === 'roll' && op.id === rollId ? [{ id: op.id, playerId: op.playerId, sides: op.sides, value: op.value, at: op.at }] : []).find(Boolean);
  const withdraw = (game: Game, playerId: string, patches: ResolutionPatch[], dependent: (owner: number | undefined) => boolean, rollOwner: Map<string, string>) => {
    for (const roll of game.rolls) if (roll.playerId === playerId) {
      const owner = rollOwner.get(roll.id);
      if (dependent(owner !== undefined && graph.has(owner) ? graph.idx(owner) : undefined)) patches.push({ type: 'remove-roll', rollId: roll.id });
    }
  };
  for (let round = 0; round <= 4 * GAME_OPERATIONS; round++) {
    const { game, deferred, rollOwner } = materialize(history);
    const patches: ResolutionPatch[] = [];
    let candidates: number[] = [];
    const collision = deferred.find(d => d.kind === 'roll'), duplicate = deferred.find(d => d.kind === 'add');
    const absent = deferred.find(d => d.kind === 'player')?.key ?? game.rolls.find(r => !game.players.some(p => p.id === r.playerId))?.playerId;
    const groups = new Map<string, Player[]>();
    for (const p of game.players) groups.set(p.name.toLowerCase(), [...(groups.get(p.name.toLowerCase()) ?? []), p]);
    const group = [...groups.entries()].sort(([a], [b]) => byId(a, b)).find(([, list]) => list.length > 1)?.[1];
    if (collision) {
      const rollId = collision.key, retained = baselineRoll(rollId), current = game.rolls.find(r => r.id === rollId);
      candidates = nodes.flatMap((node, i) => node.seed?.rolls.some(r => r.id === rollId) ? [i] : []);
      if (!retained) patches.push({ type: 'remove-roll', rollId });
      else { if (!same(current, retained)) patches.push({ type: 'remove-roll', rollId }); patches.push({ type: 'put-roll', roll: retained }); }
    } else if (duplicate) {
      const playerId = duplicate.key, list = creators.get(playerId) ?? [];
      const kept = list.find(i => inMask(inBaseline, i)) ?? list.find(i => graph.authors[i] === priority.participantId);
      const losers = list.filter(i => i !== kept);
      candidates = [...list];
      let record: Player | undefined;
      if (kept !== undefined) {
        // The kept record's fields come from causal history excluding the losing creations' lineage,
        // so valid edits to the kept player (including the priority participant's) survive.
        const mask = new Uint32Array(inBaseline.length);
        nodes.forEach((_, i) => { if (!losers.some(l => upTo(l, i))) mask[i >>> 5] |= 1 << (i & 31); });
        const created = nodes[kept].seed?.players.find(p => p.id === playerId) ?? (nodes[kept].op as Extract<GameOperation, { type: 'add-player' }>).player;
        const field = (f: 'name' | 'role') => {
          const reg = `player:${playerId}.${f}`;
          candidates.push(...graph.maximal(graph.members(mask).filter(i => graph.writes[i].has(reg))));
          return valueIn(reg, mask, 0) ?? created[f];
        };
        record = { id: playerId, name: field('name'), role: field('role') as Player['role'] };
      }
      patches.push(record ? { type: 'put-player', player: record } : { type: 'remove-player', playerId });
      withdraw(game, playerId, patches, owner => kept === undefined || (owner !== undefined && losers.some(l => upTo(l, owner))), rollOwner);
    } else if (absent !== undefined) {
      candidates = [
        ...deferred.filter(d => d.kind === 'player' && d.key === absent).map(d => graph.idx(d.id)),
        ...game.rolls.flatMap(r => r.playerId === absent && graph.has(rollOwner.get(r.id) ?? '') ? [graph.idx(rollOwner.get(r.id)!)] : []),
      ];
      patches.push({ type: 'remove-player', playerId: absent });
      withdraw(game, absent, patches, () => true, rollOwner);
    } else if (group) {
      const producers = (p: Player) => graph.maximal(nodes.map((_, i) => i).filter(i => graph.writes[i].get(`player:${p.id}.name`)?.toLowerCase() === p.name.toLowerCase()));
      const kept = group.filter(p => baselineGame.players.some(b => b.id === p.id && b.name.toLowerCase() === p.name.toLowerCase())
        || producers(p).some(i => graph.authors[i] === priority.participantId)).slice(0, 1);
      for (const p of group) {
        candidates.push(...producers(p));
        if (kept.includes(p)) continue;
        const before = baselineGame.players.find(b => b.id === p.id);
        if (before) patches.push({ type: 'set-player-name', playerId: p.id, name: before.name });
        else { patches.push({ type: 'remove-player', playerId: p.id }); withdraw(game, p.id, patches, () => true, rollOwner); }
      }
    } else if (game.players.length > 32) {
      // Keep the priority roster (baseline plus the priority participant's own additions) and withhold
      // every concurrently competing addition: the causally latest additions not made by the priority.
      const additionCreators = game.players.flatMap(p => baselineGame.players.some(b => b.id === p.id) ? [] : (creators.get(p.id) ?? []));
      const owned = (id: string) => (creators.get(id) ?? []).some(i => inMask(inBaseline, i) || graph.authors[i] === priority.participantId);
      const extra = game.players.filter(p => !baselineGame.players.some(b => b.id === p.id) && !owned(p.id)
        && (creators.get(p.id) ?? []).every(c => !additionCreators.some(o => o !== c && graph.below(c, o)))).map(p => p.id).sort(byId);
      check(extra.length > 0, 'Games need 1–32 players.');
      for (const playerId of extra) {
        candidates.push(...(creators.get(playerId) ?? []));
        patches.push({ type: 'remove-player', playerId });
        withdraw(game, playerId, patches, () => true, rollOwner);
      }
    } else break;
    candidates = [...new Set(candidates)].sort((a, b) => a - b);
    publish(patches, candidates, candidates.length ? graph.maximal(graph.members(graph.common(candidates))) : []);
  }

  history = validateHistory(history);
  const game = projectHistory(history);
  const seen = new Set(Object.keys(histories[0].operations ?? {}));
  const notices = new Map<string, ConflictNotice>();
  const final = new Graph([...Object.keys(history.seeds).sort(byId).map(id => ({ id, seed: history.seeds[id] })), ...orderOps(history)]);
  const fresh = Object.values(history.operations).filter((op): op is Resolution => op.type === 'resolution' && !seen.has(op.id));
  const extended = new Set(fresh.flatMap(op => op.extendedResolutionIds));
  for (const op of fresh) {
    // A chain link or an extended resolution is reported through the resolution that extends it.
    if (extended.has(op.id)) continue;
    const notice = noticeFor(op, final);
    if (notice) notices.set(notice.id, notice);
  }
  return {
    history, game,
    notices: [...notices.values()].sort((a, b) => byId(a.affected.join(), b.affected.join()) || byId(a.id, b.id)),
    pendingIds: pending,
    rejectedIds: [...rejected].sort(byId),
  };
}

function noticeFor(op: Resolution, graph: Graph): ConflictNotice | undefined {
  if (!op.candidateHeads.every(id => graph.has(id))) return undefined;
  const heads = op.candidateHeads.map(id => graph.idx(id));
  const setters = op.patches.filter(p => p.type === 'set-game-name' || p.type === 'set-player-name' || p.type === 'set-player-role');
  const key = (p: ResolutionPatch) => p.type === 'set-game-name' ? 'game.name' : p.type === 'set-player-name' ? `player:${p.playerId}.name` : p.type === 'set-player-role' ? `player:${p.playerId}.role` : p.type === 'remove-player' ? `player:${p.playerId}` : p.type === 'put-player' ? `player:${p.player.id}` : p.type === 'put-roll' ? `roll:${p.roll.id}` : '';
  const patchValue = (p: ResolutionPatch) => p.type === 'set-game-name' || p.type === 'set-player-name' ? p.name : p.type === 'set-player-role' ? p.role : p.type === 'put-player' ? p.player : null;
  const reg = setters.length === 1 && op.patches.length === 1 ? key(setters[0]) : undefined;
  const single = reg !== undefined && heads.every(i => graph.writes[i].has(reg));
  const reason: ConflictNotice['reason'] = op.fallbackBase.length === 0 ? 'limited-history' : single ? 'concurrent-value' : 'invariant';
  const leaves = graph.expand(heads, single ? reg : undefined);
  const keys = [...new Set(op.patches.map(key).filter(Boolean))];
  const affected = single ? [reg!] : (keys.length ? keys : [...new Set(op.patches.flatMap(p => p.type === 'remove-roll' ? [`roll:${p.rollId}`] : []))]).sort(byId);
  const candidates = leaves.map(i => {
    const w = graph.writes[i];
    const node = graph.nodes[i], op = node.op, rollIds = affected.filter(a => a.startsWith('roll:')).map(a => a.slice(5));
    const value = single ? w.get(reg!)
      : node.seed && rollIds.length ? node.seed.rolls.filter(r => rollIds.includes(r.id))
      : op?.type === 'add-player' ? op.player
      : op?.type === 'set-player-name' || op?.type === 'set-player-role' ? { playerId: op.playerId, ...(op.type === 'set-player-name' ? { name: op.name } : { role: op.role }) }
      : op?.type === 'roll' ? { rollId: op.id, playerId: op.playerId }
      : [...w.entries()].filter(([k]) => k.endsWith('.name') && k.startsWith('player:')).map(([k, v]) => ({ playerId: k.slice(7, -5), name: v }));
    return { operationId: graph.nodes[i].id, value };
  });
  const retained = single ? patchValue(op.patches[0]) : Object.fromEntries(op.patches.filter(p => p.type !== 'remove-roll').map(p => [key(p), p.type === 'put-roll' ? p.roll : patchValue(p)]));
  const id = `conflict-${hash(JSON.stringify([reason, affected, candidates.map(c => c.operationId)]))}`;
  const competing = candidates.map(c => `${c.operationId} proposed ${describe(c.value)}`).join('; ');
  const explanation = reason === 'invariant'
    ? `Changes to ${affected.join(', ')} would break the rule that player names are unique (${competing}). The first room participant's version was kept (${describe(retained)}); the other proposals remain in history for recovery.`
    : reason === 'limited-history'
      ? `Copies of ${affected.join(', ')} have no shared history (${competing}). Compatible additions were merged and the first room participant's value ${describe(retained)} was kept.`
      : `${affected[0]} was changed concurrently (${competing}). The first room participant's version ${describe(retained)} was kept.`;
  return { id, affected, reason, candidates, retained, explanation };
}
