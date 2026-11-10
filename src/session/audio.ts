import * as Y from 'yjs';
import {
  audioTrackBytes, compareAudioTracks, comparePlaybackCommands, latestPlaybackCommand, mergeAudioTrack,
  validatePlaybackCommand, createAudioTrack,
  type AudioPositionBody, type AudioTombstone, type AudioTrack, type AudioTrackInput,
  type AudioTransferMeta, type PlaybackCommand,
} from '../game/audio';
import type { Runtime } from '../game/types';
import { check, id } from '../game/validation';
import type { Workspace } from '../game/workspace';
import { AUDIO_LEAD_MS, AUDIO_MAX_DURATION_MS, AUDIO_METADATA_BYTES, AUDIO_TRACKS } from '../network/limits';
import type { AudioPositionResult, RoomAudioHandlers, RoomTransport } from '../network/room';
import {
  pruneStagedAudio, publishAudio, readPlaybackCommands, readStagedAudio, writePlaybackCommand,
} from './workspace-bridge';

/**
 * The shared audio view: the durable library plus the transient playback anchor.
 *
 * `positionMs` is the anchor decision point, not a live playhead: while `playing` is true,
 * playback begins at `positionMs` at `startedAt` (wall clock, `now()` scale). Consumers
 * derive the current position as `positionMs + max(0, now() - startedAt)`.
 */
export type AudioSessionView = {
  tracks: AudioTrack[];
  tombstones: string[];
  currentTrackId: string | null;
  playing: boolean;
  positionMs: number;
  startedAt: number | null;
  rev: number;
  resyncPending: boolean;
  approximate: boolean;
  connected: boolean;
  canControl: boolean;
};

export function emptyAudioSessionView(): AudioSessionView {
  return {
    tracks: [],
    tombstones: [],
    currentTrackId: null,
    playing: false,
    positionMs: 0,
    startedAt: null,
    rev: 0,
    resyncPending: false,
    approximate: false,
    connected: false,
    canControl: false,
  };
}

export type AudioSessionOptions = {
  stage: Y.Doc;
  workspace: Workspace;
  now: () => number;
  runtime: Runtime;
  onError(message: string): void;
  onDirty(): void;
  /** Stable room participant id used for command tie-breaking and position requests. */
  participantId?: string;
};

export type AudioTrackListener = (bytes: Uint8Array, meta: AudioTransferMeta, peerId: string) => void;
export type AudioRequestListener = (trackId: string, peerId: string) => boolean | Promise<boolean>;
export type AudioPositionListener = (trackId: string, peerId: string) => AudioPositionBody | null | Promise<AudioPositionBody | null>;

export type AudioSession = {
  getView(): AudioSessionView;
  sync(): void;
  setTransport(transport: RoomTransport | null): void;
  setLocalPlayerId(id: string | null): void;
  addTrack(input: AudioTrackInput): void;
  removeTrack(trackId: string): void;
  setTrackGain(trackId: string, gain: number): void;
  selectTrack(trackId: string): void;
  playTrack(): void;
  stopTrack(): void;
  seekTrack(positionMs: number): void;
  sendAudioTrack(bytes: Uint8Array, meta: AudioTransferMeta, target?: string | string[], onProgress?: (fraction: number, peerId: string) => void): Promise<void>;
  requestAudioHolders(trackId: string): Promise<string[]>;
  requestAudioTrack(trackId: string, peerId: string): Promise<boolean>;
  requestAudioPosition(trackId: string, preferredPeer?: string): Promise<AudioPositionResult | null>;
  onAudioTrack(fn: AudioTrackListener): () => void;
  onAudioFetch(fn: AudioRequestListener): () => void;
  onAudioWho(fn: AudioRequestListener): () => void;
  onAudioPosition(fn: AudioPositionListener): () => void;
  destroy(): void;
};

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function clampPosition(value: number, max: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.round(value), Math.max(0, max));
}

/**
 * Orchestrates shared audio: it merges staged metadata and tombstones into the durable
 * workspace, mirrors the merged library back to staging, applies the bounded playback
 * command log, and owns the shared anchor state machine.
 *
 * Library metadata is durable; playback commands are transient and never reach the
 * workspace. The session never trusts staged or peer data: it only applies records that
 * the stage helpers and the domain validators accepted.
 */
export function createAudioSession(options: AudioSessionOptions): AudioSession {
  const { stage, workspace, now, runtime, onError, onDirty } = options;
  const participantId = id(options.participantId ?? runtime.id());

  const trackListeners = new Set<AudioTrackListener>();
  const fetchListeners = new Set<AudioRequestListener>();
  const whoListeners = new Set<AudioRequestListener>();
  const positionListeners = new Set<AudioPositionListener>();

  let transport: RoomTransport | null = null;
  let unsubTransport: (() => void) | null = null;
  let destroyed = false;
  let localPlayerId: string | null = null;

  // Playback anchor: `positionMs` is the position at `startedAt` while playing.
  let currentTrackId: string | null = null;
  let currentCommand: PlaybackCommand | null = null;
  let playing = false;
  let positionMs = 0;
  let startedAt: number | null = null;
  let rev = 0;
  let approximate = false;
  let resyncPending = false;
  let resync: { token: number; command: PlaybackCommand } | null = null;
  let resyncToken = 0;

  // Late join/reconnect: the next sync that sees a command decides once whether to
  // ask the issuer for the current position.
  let wasConnected = false;
  let pendingJoin = false;

  // True while a local bound prevents at least one valid staged record from merging.
  // The warning is surfaced on the complete → blocked transition only, and cleared
  // once a later merge proves the library fits again.
  let libraryBlocked = false;

  function connected(): boolean {
    if (destroyed || transport === null) return false;
    const view = transport.getView();
    return view.phase === 'connected' && view.openRtcConnections > 0;
  }

  function durationOf(trackId: string | null): number {
    if (trackId === null) return AUDIO_MAX_DURATION_MS;
    return workspace.getTracks().find(track => track.id === trackId)?.durationMs ?? AUDIO_MAX_DURATION_MS;
  }

  function derivedPosition(): number {
    const elapsed = playing && startedAt !== null ? Math.max(0, now() - startedAt) : 0;
    return clampPosition(positionMs + elapsed, durationOf(currentTrackId));
  }

  function clearCurrent(): void {
    currentTrackId = null;
    playing = false;
    positionMs = 0;
    startedAt = null;
    approximate = false;
    resyncPending = false;
    resync = null;
    resyncToken++;
  }

  /**
   * An overflow in the staged/durable audio window is not a data-validity problem: the
   * durable library wins, and staged records that do not fit are skipped (tombstones first,
   * because they always win). Returns true when at least one valid staged record was
   * skipped for local capacity, so the caller can leave it staged for roomier peers.
   */
  function salvageLibrary(tracks: readonly AudioTrack[], tombstones: readonly AudioTombstone[]): boolean {
    let lossy = false;
    try {
      workspace.mergeAudio([], tombstones);
    } catch {
      for (const tombstone of tombstones) {
        try { workspace.mergeAudio([], [tombstone]); } catch { lossy = true; }
      }
    }
    const removed = new Set(workspace.getTombstones().map(tombstone => tombstone.id));
    const simulated = new Map(workspace.getTracks().map(track => [track.id, track]));
    let bytes = [...simulated.values()].reduce((total, track) => total + audioTrackBytes(track), 0);
    const chosen: AudioTrack[] = [];
    for (const incoming of [...tracks].sort(compareAudioTracks)) {
      if (removed.has(incoming.id)) continue;
      const existing = simulated.get(incoming.id);
      const merged = existing === undefined ? incoming : mergeAudioTrack(existing, incoming);
      const nextBytes = bytes - (existing === undefined ? 0 : audioTrackBytes(existing)) + audioTrackBytes(merged);
      if (simulated.size + (existing === undefined ? 1 : 0) > AUDIO_TRACKS) { lossy = true; continue; }
      if (nextBytes > AUDIO_METADATA_BYTES) { lossy = true; continue; }
      simulated.set(merged.id, merged);
      bytes = nextBytes;
      chosen.push(merged);
    }
    if (chosen.length > 0) {
      try {
        workspace.mergeAudio(chosen, []);
      } catch {
        for (const track of chosen) {
          try { workspace.mergeAudio([track], []); } catch { lossy = true; }
        }
      }
    }
    return lossy;
  }

  /** Merges staged audio; returns true when a local bound skipped a valid staged record. */
  function mergeStagedAudio(tracks: readonly AudioTrack[], tombstones: readonly AudioTombstone[]): boolean {
    try {
      workspace.mergeAudio(tracks, tombstones);
      libraryBlocked = false;
      return false;
    } catch {
      let lossy = true;
      try { lossy = salvageLibrary(tracks, tombstones); } catch { /* keep the accepted library */ }
      if (lossy && !libraryBlocked) onError('The shared audio library is full; some shared changes could not be merged.');
      libraryBlocked = lossy;
      return lossy;
    }
  }

  function publishLibrary(prune: boolean): void {
    try {
      const tracks = workspace.getTracks(), tombstones = workspace.getTombstones();
      publishAudio(stage, tracks, tombstones);
      // Records skipped for local capacity stay staged: a roomier peer may accept them.
      if (prune) pruneStagedAudio(stage, tracks, tombstones);
    } catch (error) {
      onError(message(error, 'The audio library could not be synchronized.'));
    }
  }

  function reconcileTombstonedCurrent(): void {
    if (currentTrackId === null) return;
    if (!workspace.getTombstones().some(tombstone => tombstone.id === currentTrackId)) return;
    // A removed current track stops locally; another track is never selected automatically.
    clearCurrent();
  }

  function syncLibrary(): void {
    const staged = readStagedAudio(stage);
    let lossy = false;
    if (staged.tracks.length > 0 || staged.tombstones.length > 0) {
      lossy = mergeStagedAudio(staged.tracks, staged.tombstones);
      reconcileTombstonedCurrent();
    }
    // Never prune records this peer could not merge: another peer with room can still
    // accept them. A complete merge is the only safe moment to shrink staging.
    publishLibrary(!lossy);
    reconcileTombstonedCurrent();
  }

  function fallbackPosition(command: PlaybackCommand): void {
    const duration = durationOf(command.trackId);
    const at = Date.parse(command.at);
    const elapsed = Number.isFinite(at) ? Math.max(0, now() - at) : 0;
    positionMs = clampPosition(command.positionMs + elapsed, duration);
    playing = command.playing;
    startedAt = command.playing ? now() + AUDIO_LEAD_MS : null;
    approximate = true;
  }

  async function requestPositionFor(command: PlaybackCommand, token: number): Promise<void> {
    let result: AudioPositionResult | null = null;
    try {
      result = await transport?.audio.requestPosition(command.trackId, command.participantId) ?? null;
    } catch {
      result = null;
    }
    // Stale guard: any newer command, a cleared current track, or teardown supersedes us.
    if (destroyed || resync?.token !== token || currentCommand?.id !== command.id || currentTrackId !== command.trackId) return;
    resync = null;
    resyncPending = false;
    if (result === null) {
      fallbackPosition(command);
      return;
    }
    const halfTrip = Math.max(0, Math.round(result.rttMs / 2));
    const body = result.position;
    positionMs = clampPosition(body.positionMs + halfTrip, durationOf(command.trackId));
    playing = body.playing;
    startedAt = body.playing ? now() + AUDIO_LEAD_MS : null;
    approximate = false;
  }

  function applyCommand(command: PlaybackCommand, requestPosition: boolean): void {
    currentCommand = command;
    rev = Math.max(rev, command.rev);
    if (workspace.getTombstones().some(tombstone => tombstone.id === command.trackId)) {
      // A command for a removed track never brings it back or selects another one.
      clearCurrent();
      return;
    }
    currentTrackId = command.trackId;
    positionMs = clampPosition(command.positionMs, durationOf(command.trackId));
    playing = command.playing;
    startedAt = command.playing ? now() + AUDIO_LEAD_MS : null;
    approximate = false;
    resync = null;
    resyncPending = false;
    resyncToken++;
    if (!requestPosition || !command.playing || command.participantId === participantId) return;
    startProbe(command);
  }

  /** Requests the room's current position and re-anchors when the answer is still current. */
  function startProbe(command: PlaybackCommand): void {
    const token = ++resyncToken;
    // Until an answer arrives the current anchor is only best effort.
    approximate = true;
    resyncPending = true;
    resync = { token, command };
    void requestPositionFor(command, token);
  }

  function syncPlayback(): void {
    const latest = latestPlaybackCommand(readPlaybackCommands(stage));
    // The first connected sync consumes the join marker even when no command exists yet,
    // so a later ordinary command is not mistaken for a late join.
    const joining = pendingJoin;
    pendingJoin = false;
    if (latest === null) return;
    const applied = currentCommand !== null && comparePlaybackCommands(latest, currentCommand) <= 0;
    if (!applied) {
      applyCommand(latest, joining);
      return;
    }
    // Reconnect: the same playing command is already applied locally, but this peer may
    // have missed playback while disconnected. Re-anchor from the room again.
    if (joining && latest.playing && comparePlaybackCommands(latest, currentCommand!) === 0) startProbe(latest);
  }

  function sync(): void {
    if (destroyed) return;
    const isConnected = connected();
    if (isConnected && !wasConnected) pendingJoin = true;
    wasConnected = isConnected;
    try {
      syncLibrary();
      syncPlayback();
    } catch (error) {
      // A malformed or overflowing stage must never break the peer refresh loop.
      onError(message(error, 'Audio could not be synchronized.'));
    }
  }

  function emitLibraryChange(): void {
    // A local edit publishes but never prunes while a local bound is blocking merge:
    // the blocked records must stay visible to roomier peers until a sync succeeds.
    publishLibrary(!libraryBlocked);
    onDirty();
  }

  function issueCommand(trackId: string, nextPlaying: boolean, position: number): void {
    const command = validatePlaybackCommand({
      id: runtime.id(),
      rev: rev + 1,
      participantId,
      trackId,
      playing: nextPlaying,
      positionMs: clampPosition(position, durationOf(trackId)),
      at: runtime.now(),
    });
    // A command is shared first; a rejected write leaves the local anchor untouched.
    writePlaybackCommand(stage, command);
    currentTrackId = command.trackId;
    currentCommand = command;
    rev = command.rev;
    positionMs = command.positionMs;
    playing = command.playing;
    startedAt = command.playing ? now() + AUDIO_LEAD_MS : null;
    approximate = false;
    resync = null;
    resyncPending = false;
    pendingJoin = false;
    resyncToken++;
    reconcileTombstonedCurrent();
    onDirty();
  }

  function requireConnection(): boolean {
    if (connected()) return true;
    onError('Audio controls require a live room connection.');
    return false;
  }

  function transportCommand(run: () => void): void {
    if (destroyed || !requireConnection()) return;
    try {
      run();
    } catch (error) {
      onError(message(error, 'The audio command could not be sent.'));
    }
  }

  function requireSeat(): string {
    check(localPlayerId !== null, 'Choose your player first.');
    return localPlayerId;
  }

  function registerHandlers(): void {
    const audio = transport?.audio;
    if (audio === undefined) return;
    const handlers: RoomAudioHandlers = {
      onTrack(bytes, meta, peerId) {
        for (const fn of [...trackListeners]) {
          try { fn(bytes, meta, peerId); } catch { /* a listener fault must not break the transport */ }
        }
      },
      async onFetch(trackId, peerId) {
        for (const fn of [...fetchListeners]) {
          try { if (await fn(trackId, peerId)) return true; } catch { /* ignore local listener faults */ }
        }
        return false;
      },
      async onWho(trackId, peerId) {
        for (const fn of [...whoListeners]) {
          try { if (await fn(trackId, peerId)) return true; } catch { /* ignore local listener faults */ }
        }
        return false;
      },
      async onPosition(trackId, peerId) {
        for (const fn of [...positionListeners]) {
          try {
            const body = await fn(trackId, peerId);
            if (body !== null) return body;
          } catch { /* ignore local listener faults */ }
        }
        return null;
      },
    };
    audio.setHandlers(handlers);
  }

  function unsubscriber<T>(set: Set<T>, fn: T): () => void {
    set.add(fn);
    return () => { set.delete(fn); };
  }

  return {
    getView(): AudioSessionView {
      const isConnected = connected();
      return {
        tracks: workspace.getTracks(),
        tombstones: workspace.getTombstones().map(tombstone => tombstone.id),
        currentTrackId,
        playing,
        positionMs,
        startedAt,
        rev,
        resyncPending,
        approximate,
        connected: isConnected,
        canControl: isConnected && localPlayerId !== null,
      };
    },

    sync,

    setTransport(next) {
      if (destroyed) return;
      unsubTransport?.();
      unsubTransport = null;
      const previous = transport?.audio;
      transport = next;
      if (previous !== undefined && previous !== next?.audio) {
        try { previous.setHandlers({}); } catch { /* the old transport may be closed */ }
      }
      // Any transport replacement starts a fresh connection tenure and invalidates an
      // in-flight probe: a response from the old connection must not re-anchor this one.
      wasConnected = false;
      pendingJoin = false;
      resync = null;
      resyncPending = false;
      resyncToken++;
      if (next !== null) {
        try {
          unsubTransport = next.subscribe(() => { if (!destroyed) onDirty(); });
          registerHandlers();
        } catch (error) {
          unsubTransport?.();
          unsubTransport = null;
          onError(message(error, 'The audio transport could not be prepared.'));
        }
      }
      onDirty();
    },

    setLocalPlayerId(value) {
      localPlayerId = value;
    },

    addTrack(input) {
      const player = requireSeat();
      workspace.addTrack(createAudioTrack(input, player, runtime.now()));
      emitLibraryChange();
    },

    removeTrack(trackId) {
      const player = requireSeat();
      workspace.removeTrack(trackId, player, runtime.now());
      if (currentTrackId === trackId) clearCurrent();
      emitLibraryChange();
    },

    setTrackGain(trackId, gain) {
      const player = requireSeat();
      workspace.setTrackGain(trackId, gain, player, runtime.now());
      emitLibraryChange();
    },

    selectTrack(trackId) {
      transportCommand(() => issueCommand(trackId, false, 0));
    },

    playTrack() {
      transportCommand(() => {
        check(currentTrackId !== null, 'Choose a track first.');
        const trackId = currentTrackId;
        const position = derivedPosition();
        // An ended track restarts from the beginning instead of issuing a play command
        // at the final sample (the playhead is clamped at the duration).
        issueCommand(trackId, true, position >= durationOf(trackId) ? 0 : position);
      });
    },

    stopTrack() {
      transportCommand(() => {
        check(currentTrackId !== null, 'Choose a track first.');
        issueCommand(currentTrackId, false, derivedPosition());
      });
    },

    seekTrack(position) {
      transportCommand(() => {
        check(currentTrackId !== null, 'Choose a track first.');
        issueCommand(currentTrackId, playing, position);
      });
    },

    async sendAudioTrack(bytes, meta, target, onProgress) {
      const audio = transport?.audio;
      if (audio === undefined) throw new Error('Audio transfer requires a live room connection.');
      await audio.sendTrack(bytes, meta, target, onProgress);
    },

    async requestAudioHolders(trackId) {
      try {
        return await transport?.audio.requestHolders(trackId) ?? [];
      } catch {
        return [];
      }
    },

    async requestAudioTrack(trackId, peerId) {
      try {
        return await transport?.audio.requestFetch(trackId, peerId) ?? false;
      } catch {
        return false;
      }
    },

    async requestAudioPosition(trackId, preferredPeer) {
      try {
        return await transport?.audio.requestPosition(trackId, preferredPeer) ?? null;
      } catch {
        return null;
      }
    },

    onAudioTrack(fn) { return unsubscriber(trackListeners, fn); },
    onAudioFetch(fn) { return unsubscriber(fetchListeners, fn); },
    onAudioWho(fn) { return unsubscriber(whoListeners, fn); },
    onAudioPosition(fn) { return unsubscriber(positionListeners, fn); },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      resyncToken++;
      resync = null;
      resyncPending = false;
      unsubTransport?.();
      unsubTransport = null;
      try { transport?.audio.setHandlers({}); } catch { /* the transport may be closed */ }
      transport = null;
      trackListeners.clear();
      fetchListeners.clear();
      whoListeners.clear();
      positionListeners.clear();
    },
  };
}
