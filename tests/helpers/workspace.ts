import type { Game, Runtime } from '../../src/game/types';
import type { GameHistory, GameOperation, WorkspaceSnapshot } from '../../src/game/sync-types';
import { projectHistory, validateHistory, validateOperation } from '../../src/game/history';
import { ENCODED_OPERATION_BYTES } from '../../src/network/limits';
import { createWorkspace, type Workspace } from '../../src/game/workspace';
import * as Y from 'yjs';

export function namedRuntime(label: string): Runtime {
  let next = 0;
  return { id: () => `${label}-${++next}`, now: () => '2026-01-01T00:00:00.000Z', die: sides => Math.min(7, sides) };
}
export function fixtureRoster(): Game {
  return { schemaVersion: 1, id: 'game', name: 'Castle', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision: 0, players: [{ id: 'alex', name: 'Alex', role: 'gm' }, { id: 'bea', name: 'Bea', role: 'pj' }, { id: 'cy', name: 'Cy', role: 'pj' }], rolls: [] };
}
export function createTestWorkspace(label: string, game = fixtureRoster()): Workspace {
  return createWorkspace(game, namedRuntime(label), label);
}
export function forkTestWorkspace(source: Workspace, label: string): Workspace {
  return createWorkspace(source.getSnapshot(), namedRuntime(label), label);
}

function sizedName(bytes: number): string {
  return '🧙'.repeat(Math.floor(bytes / 4)) + 'a'.repeat(bytes % 4);
}

/**
 * Builds a valid accepted snapshot whose encoded workspace is at the 1 MiB bound with
 * roughly `headroom` bytes to spare. Each operation is a small, name-sized record
 * (~240 bytes) so the last operation's UTF-8 name length can tune the encoded size
 * across the whole gap between operations; every build is a single Y.Doc transaction,
 * so the fixture costs a handful of encodes.
 */
export function nearCapSnapshot(headroom = 10): WorkspaceSnapshot {
  const game = fixtureRoster(), seedId = 'cap-seed';
  const maxNameBytes = 240; // 60 emoji: the 64-character limit for a player name
  let count = 2600, tail = maxNameBytes;
  for (let attempt = 0; attempt < 24; attempt++) {
    const operations: Record<string, GameOperation> = {};
    let parents: string[] = [seedId];
    for (let i = 0; i < count; i++) {
      const id = `cap-${i}`;
      operations[id] = validateOperation({
        type: 'set-player-name', playerId: 'alex', name: sizedName(i === count - 1 ? tail : maxNameBytes), id, authorId: 'cap', parents, at: '2026-01-01T00:00:00.000Z',
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
    if (room >= Math.max(0, headroom - 250) && room <= headroom) return snapshot;
    const target = headroom >= 250 ? headroom - 125 : headroom;
    const adjusted = tail + room - target - (room > target ? 8 : 0);
    if (adjusted > maxNameBytes) { count += Math.ceil((adjusted - maxNameBytes) / 400); tail = maxNameBytes; }
    else if (adjusted < 1) { count -= Math.ceil((1 - adjusted) / 400); tail = 1; }
    else tail = adjusted;
  }
  throw new Error('Unable to build a near-cap workspace snapshot.');
}
