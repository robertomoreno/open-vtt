import type { Game, Runtime } from '../../src/game/types';
export function runtime(): Runtime {
  let n = 0;
  return { id: () => `id-${++n}`, now: () => '2026-10-27T12:00:00.000Z', die: () => 4 };
}
export function fixtureGame(): Game {
  return { schemaVersion: 1, id: 'game', name: 'Lantern Road', createdAt: '2026-10-27T12:00:00.000Z', updatedAt: '2026-10-27T12:00:00.000Z', revision: 0, players: [{id:'alex', name:'Alex', role:'gm'}], rolls: [] };
}
