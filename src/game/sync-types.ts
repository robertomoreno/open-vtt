import type { DieSides, Game, Player, Role, Roll } from './types';

export type WorkspaceSnapshot = { game: Game; history: Uint8Array };
export type LocalEdit =
  | { type: 'set-game-name'; name: string }
  | { type: 'set-player-name'; playerId: string; name: string }
  | { type: 'set-player-role'; playerId: string; role: Role }
  | { type: 'roll'; playerId: string; sides: DieSides };

export type ResolutionPatch =
  | { type: 'set-game-name'; name: string }
  | { type: 'set-player-name'; playerId: string; name: string }
  | { type: 'set-player-role'; playerId: string; role: Role }
  | { type: 'put-player'; player: Player }
  | { type: 'remove-player'; playerId: string }
  | { type: 'put-roll'; roll: Roll }
  | { type: 'remove-roll'; rollId: string };
type OperationBase = { id: string; authorId: string; parents: string[]; at: string };
export type GameOperation = OperationBase & (
  | Exclude<LocalEdit, { type: 'roll' }>
  | { type: 'add-player'; player: Player }
  | { type: 'roll'; playerId: string; sides: DieSides; value: number }
  | { type: 'resolution'; patches: ResolutionPatch[]; candidateHeads: string[]; fallbackBase: string[]; fallbackFrontier: string[]; extendedResolutionIds: string[] }
);
export type GameHistory = { modelVersion: 1; gameId: string; seeds: Record<string, Game>; operations: Record<string, GameOperation> };
export type ConflictNotice = { id: string; affected: string[]; reason: 'concurrent-value' | 'invariant' | 'limited-history'; candidates: { operationId: string; value: unknown }[]; retained: unknown; explanation: string };
export type PriorityContext = { participantId: string; tenureId: string; baseline: GameHistory };
export type Reconciliation = { history: GameHistory; game: Game; notices: ConflictNotice[]; pendingIds: string[]; rejectedIds: string[] };
