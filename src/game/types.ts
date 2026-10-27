export type Role = 'gm' | 'pj';
export const dice = [4, 6, 8, 10, 12, 20, 100] as const;
export type DieSides = typeof dice[number];
export type Player = { id: string; name: string; role: Role };
export type Roll = { id: string; playerId: string; sides: DieSides; value: number; at: string };
export type Game = { schemaVersion: 1; id: string; name: string; createdAt: string; updatedAt: string; revision: number; players: Player[]; rolls: Roll[] };
export type Runtime = { id(): string; now(): string; die(sides: DieSides): number };
