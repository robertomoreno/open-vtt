import type { Game, Runtime } from '../../src/game/types';
import { createWorkspace, type Workspace } from '../../src/game/workspace';

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
