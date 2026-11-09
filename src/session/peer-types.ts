import type { ConflictNotice, LocalEdit, WorkspaceSnapshot } from '../game/sync-types';
import type { DieSides, Game, Role, Runtime } from '../game/types';
import type { RoomLink } from '../network/room-link';
import type { createRoomTransport } from '../network/room';

/**
 * Shared session contracts. Task 7 contributes the transient membership types; Task 8
 * completes the `PeerSessionView` and peer session controller contracts.
 *
 * A peer session orchestrates one durable causal workspace, one transient staging Y.Doc
 * (synced by the room transport), and one transient logical membership. Durable game data
 * and transient room state never mix: `getSnapshot()` only ever returns game data, and
 * membership/tenure/claims never enter durable history.
 */
export type { Member, Membership, MembershipEvent, MembershipOptions, MembershipView, Tenure } from './membership';
export { createMembership, validateMembershipEvent } from './membership';

/**
 * - `local`: no room; the workspace (if any) is purely local.
 * - `waiting`: a room is open/joined but no native channel is established yet.
 * - `syncing`: connected, but the game is not yet bootstrapped/admitted/admission-granted.
 * - `choosing`: synchronized; no local player is selected.
 * - `ready`: synchronized with a selected local player.
 * - `offline`: the room connection was lost without an explicit local disconnect.
 * - `closed`: the controller is destroyed.
 */
export type PeerSessionPhase = 'local' | 'waiting' | 'syncing' | 'choosing' | 'ready' | 'offline' | 'closed';

export type PeerSessionView = {
  game: Game | null;
  phase: PeerSessionPhase;
  /** The locally selected player, confirmed by the priority participant or local/unconfirmed. */
  localPlayerId: string | null;
  /** Player ids whose claimants are currently reachable, sorted. */
  onlinePlayerIds: string[];
  /** The active priority participant (membership tenure leader), or null when unknown. */
  priorityParticipantId: string | null;
  canCreatePlayer: boolean;
  canRoll: boolean;
  hasRecovery: boolean;
  conflicts: ConflictNotice[];
  /** Last action/join error surfaced by the session. */
  error: string | null;
  /** Live transport error (for example failed ICE or wrong room password), if any. */
  connectionError: string | null;
  /**
   * Monotonic per-controller counter that changes only for accepted workspace changes.
   * It is never the game revision and never a global counter.
   */
  saveGeneration: number;
};

export type PeerSessionOptions = {
  initial: WorkspaceSnapshot | null;
  rememberedPlayerId: string | null;
  runtime: Runtime;
  /** Local monotonic clock in milliseconds, used for presence expiry, intent expiry and rate limits. */
  now: () => number;
  createTransport?: typeof createRoomTransport;
};

export type PeerSession = {
  getView(): PeerSessionView;
  getSnapshot(): WorkspaceSnapshot | null;
  getRecoverySnapshot(): WorkspaceSnapshot | null;
  getRoomLink(): RoomLink | null;
  subscribe(fn: () => void): () => void;
  openRoom(): RoomLink | null;
  joinRoom(link: RoomLink): void;
  selectPlayer(id: string): void;
  createPlayer(name: string, role: Role): void;
  roll(sides: DieSides): void;
  edit(edit: LocalEdit): void;
  disconnect(): void;
  close(): void;
};
