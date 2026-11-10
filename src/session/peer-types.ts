import type { AudioPositionBody, AudioTrackInput, AudioTransferMeta } from '../game/audio';
import type { ChatImage, ChatImageInput, ChatMessage, ChatRecipients } from '../game/chat';
import type { ConflictNotice, LocalEdit, WorkspaceSnapshot } from '../game/sync-types';
import type { DieSides, Game, Role, Runtime } from '../game/types';
import type { RoomLink } from '../network/room-link';
import type { AudioPositionResult, createRoomTransport } from '../network/room';
import type { AudioSessionView } from './audio';

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
  /** True when the seated local player may post chat, local or connected. */
  canChat: boolean;
  /** Durable chat text, oldest first, detached from the workspace. */
  messages: ChatMessage[];
  /** Live-only images currently staged for this session, oldest first. */
  liveImages: ChatImage[];
  hasRecovery: boolean;
  /** True when this controller holds a room link, connected or not. */
  hasRoomLink: boolean;
  /** Admitted, reachable remote participants without a confirmed player claim. */
  unseatedParticipantCount: number;
  conflicts: ConflictNotice[];
  /** Last action/join error surfaced by the session. */
  error: string | null;
  /** Live transport error (for example failed ICE or wrong room password), if any. */
  connectionError: string | null;
  /** Shared audio library and transient playback state; absent in unrelated UI fixtures. */
  audio?: AudioSessionView;
  /**
   * Monotonic per-controller counter that changes only for accepted workspace changes.
   * It is never the game revision and never a global counter.
   */
  saveGeneration: number;
};

/**
 * One outgoing chat draft. Text is durable; an attached image is live-only and never saved.
 * `recipients: null` is public; a list is normalized with the sender included.
 */
export type ChatDraft = {
  text: string;
  recipients: ChatRecipients;
  image?: ChatImageInput;
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
  /** Posts one chat draft; returns whether the action was accepted (see `view.error`). */
  sendMessage(draft: ChatDraft): boolean;
  roll(sides: DieSides): void;
  edit(edit: LocalEdit): void;
  /** Adds an audio track as the seated player; false when no workspace exists or the action failed. */
  addTrack(input: AudioTrackInput): boolean;
  removeTrack(trackId: string): void;
  /** Sets a shared track gain; false when no workspace exists or the action failed. */
  setTrackGain(trackId: string, gain: number): boolean;
  selectTrack(trackId: string): void;
  playTrack(): void;
  stopTrack(): void;
  seekTrack(positionMs: number): void;
  sendAudioTrack(bytes: Uint8Array, meta: AudioTransferMeta, target?: string | string[], onProgress?: (fraction: number, peerId: string) => void): Promise<void>;
  requestAudioHolders(trackId: string): Promise<string[]>;
  requestAudioTrack(trackId: string, peerId: string): Promise<boolean>;
  requestAudioPosition(trackId: string, preferredPeer?: string): Promise<AudioPositionResult | null>;
  onAudioTrack(fn: (bytes: Uint8Array, meta: AudioTransferMeta, peerId: string) => void): () => void;
  onAudioFetch(fn: (trackId: string, peerId: string) => boolean | Promise<boolean>): () => void;
  onAudioWho(fn: (trackId: string, peerId: string) => boolean | Promise<boolean>): () => void;
  onAudioPosition(fn: (trackId: string, peerId: string) => AudioPositionBody | null | Promise<AudioPositionBody | null>): () => void;
  disconnect(): void;
  close(): void;
};
