import { sha256Hex, type AudioTrack, type AudioTransferMeta } from '../game/audio';
import type { AudioSessionView } from '../session/audio';
import type { PeerSession } from '../session/peer-types';
import type { WorkspaceRepository } from '../storage/workspace-repository';
import { AUDIO_BYTES, AUDIO_DRIFT_MS } from '../network/limits';
import { prepareAudioFile, type PrepareAudioDeps } from './audio-file';

/**
 * One active library track decorated with this browser's transfer state.
 *
 * `available` means the bytes are readable locally (durable storage or the in-memory
 * fallback); `downloading`/`progress` describe an in-flight incoming transfer; `ended`
 * is only ever true for the current track and is derived from the local element.
 */
export type AudioTrackView = AudioTrack & {
  available: boolean;
  downloading: boolean;
  progress: number;
  current: boolean;
  ended: boolean;
};

/** The peer session surface the controller consumes (Task 7 audio API). */
export type AudioSessionPort = Pick<
  PeerSession,
  | 'getView'
  | 'subscribe'
  | 'addTrack'
  | 'removeTrack'
  | 'setTrackGain'
  | 'selectTrack'
  | 'playTrack'
  | 'stopTrack'
  | 'seekTrack'
  | 'sendAudioTrack'
  | 'requestAudioHolders'
  | 'requestAudioTrack'
  | 'requestAudioPosition'
  | 'onAudioTrack'
  | 'onAudioProgress'
  | 'onAudioFetch'
  | 'onAudioWho'
  | 'onAudioPosition'
>;

/** The workspace repository surface needed to keep audio bytes off the durable game. */
export type AudioStorePort = Pick<
  WorkspaceRepository,
  'putAudio' | 'getAudio' | 'hasAudio' | 'removeAudio' | 'removeGameAudio' | 'listAudio'
>;

export type AudioPanelView = {
  tracks: AudioTrackView[];
  currentTrackId: string | null;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  gain: number;
  localVolume: number;
  needsSound: boolean;
  connected: boolean;
  canAdd: boolean;
  canControl: boolean;
  canRemove: boolean;
  usageBytes: number;
  status: string | null;
};

export type AudioActions = {
  add(file: File): Promise<void>;
  remove(id: string): void;
  select(id: string): void;
  toggle(): void;
  seek(ms: number): void;
  setGain(value: number): void;
  setLocalVolume(value: number): void;
  enableSound(): Promise<void>;
  retry(id: string): Promise<void>;
};

export type AudioController = {
  getView(): AudioPanelView;
  actions: AudioActions;
  subscribe(fn: () => void): () => void;
  destroy(): void;
};

export type AudioControllerOptions = {
  session: AudioSessionPort;
  repository: AudioStorePort;
  gameId: string;
  now?: () => number;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  /** Injected for tests; the default element is appended to `document.body`. */
  createAudio?: () => HTMLAudioElement;
  /** Injected for tests; `null` means Web Audio is unavailable. */
  createContext?: () => AudioContext | null;
  confirm?: (message: string) => boolean;
  probeDuration?: (file: File) => Promise<number>;
  /** jsdom's `canPlayType` always returns '', so tests inject a permissive probe. */
  canPlay?: (type: string) => boolean;
};

type Graph = {
  context: AudioContext;
  shared: GainNode;
  limiter: DynamicsCompressorNode;
  local: GainNode;
};

const MASTER_KEY = 'gather:audio:master';
const TICK_MS = 250;
const PROGRESS_NOTIFY_MS = 100;
const PERSISTENCE_WARNING = 'Audio is in memory only; this browser could not persist the file, so it must be fetched again after reload.';
const UNAVAILABLE_MESSAGE = 'That track is not available in this room; waiting for a participant with the file.';
const SEND_FAILURE = 'That track could not be sent to peers.';

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Copy into a plain ArrayBuffer: peer payloads may be views into a larger or shared buffer.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function defaultConfirm(message: string): boolean {
  if (typeof globalThis.confirm !== 'function') return true;
  try {
    return globalThis.confirm(message);
  } catch {
    return true;
  }
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function defaultCreateAudio(): HTMLAudioElement {
  const audio = document.createElement('audio');
  audio.id = 'music-audio';
  audio.hidden = true;
  audio.preload = 'auto';
  document.body.append(audio);
  return audio;
}

function defaultCreateContext(): AudioContext | null {
  const constructors = globalThis as unknown as {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  const ctor = constructors.AudioContext ?? constructors.webkitAudioContext;
  if (typeof ctor !== 'function') return null;
  try {
    return new ctor();
  } catch {
    return null;
  }
}

function ramp(parameter: AudioParam | undefined, value: number, context: AudioContext): void {
  if (parameter === undefined) return;
  try {
    if (typeof parameter.setTargetAtTime === 'function') parameter.setTargetAtTime(value, context.currentTime, 0.02);
    else parameter.value = value;
  } catch {
    /* a closed or partially implemented context must never break playback */
  }
}

/**
 * Owns the one persistent music element, the local byte availability map, the transfer
 * handlers, and the optional Web Audio graph. It is deliberately independent of any
 * replaceable panel so switching screens never stops the music.
 *
 * The session view's `startedAt` already includes `AUDIO_LEAD_MS`; the controller waits
 * for that instant, derives the expected playhead from the anchor, and seeks only when the
 * element has drifted beyond `AUDIO_DRIFT_MS`. It never accumulates elapsed ticks, so a
 * throttled background tab still recomputes the correct position.
 */
export function createAudioController(options: AudioControllerOptions): AudioController {
  const { session, repository, gameId } = options;
  const now = options.now ?? (() => Date.now());
  const storage = options.storage ?? defaultStorage();
  const confirmAction = options.confirm ?? defaultConfirm;
  const createContext = options.createContext ?? defaultCreateContext;
  const listeners = new Set<() => void>();

  let audio: HTMLAudioElement;
  let ownsElement = false;
  if (options.createAudio) {
    audio = options.createAudio();
  } else if (typeof document === 'undefined') {
    throw new Error('Audio playback requires a browser document.');
  } else {
    audio = defaultCreateAudio();
    ownsElement = true;
  }

  // ── local byte state ────────────────────────────────────────────────────────────────
  /** Track ids the repository listed on creation or after a reconnect. */
  const diskIds = new Set<string>();
  /** Track ids written successfully during this session. */
  const storedIds = new Set<string>();
  /** Bytes kept only in memory after durable storage failed. */
  const memoryBytes = new Map<string, ArrayBuffer>();
  /** Tombstoned ids, refreshed from every session view; bytes are never accepted again. */
  const tombstoneIds = new Set<string>();
  const purged = new Set<string>();
  const attempted = new Set<string>();
  const fetching = new Set<string>();
  const downloading = new Set<string>();
  const receiving = new Set<string>();
  const progressById = new Map<string, number>();
  let availabilityLoaded = false;

  let destroyed = false;
  let statusMessage: string | null = null;

  // ── element/source state ────────────────────────────────────────────────────────────
  let loadedId: string | null = null;
  let objectUrl: string | null = null;
  let pendingSeekMs: number | null = null;
  let loadingId: string | null = null;

  // ── playback/audio graph state ──────────────────────────────────────────────────────
  let gainOverride: number | null = null;
  let localVolume = readMaster();
  let needsSound = false;
  let graphAttempted = false;
  let graph: Graph | null = null;
  let playAttempt = 0;
  let lastConnected = false;
  let lastProgressNotify = Number.NEGATIVE_INFINITY;

  function readMaster(): number {
    try {
      const raw = storage?.getItem(MASTER_KEY) ?? null;
      if (raw === null) return 100;
      const value = Number(raw);
      if (!Number.isFinite(value)) return 100;
      return clamp(Math.round(value * 100), 0, 100);
    } catch {
      return 100;
    }
  }

  function persistMaster(): void {
    try {
      storage?.setItem(MASTER_KEY, String(localVolume / 100));
    } catch {
      /* a denied storage area must not break the local volume control */
    }
  }

  function notify(): void {
    if (destroyed) return;
    for (const fn of [...listeners]) {
      try { fn(); } catch { /* a panel listener fault must not break playback */ }
    }
  }

  function notifyProgress(): void {
    const at = now();
    if (at - lastProgressNotify < PROGRESS_NOTIFY_MS) return;
    lastProgressNotify = at;
    notify();
  }

  function audioView(): AudioSessionView | undefined {
    return session.getView().audio;
  }

  function trackFor(view: AudioSessionView | undefined, trackId: string): AudioTrack | undefined {
    return view?.tracks.find(track => track.id === trackId);
  }

  function isTombstoned(id: string): boolean {
    return tombstoneIds.has(id);
  }

  function hasLocal(id: string): boolean {
    if (isTombstoned(id)) return false;
    return memoryBytes.has(id) || storedIds.has(id) || diskIds.has(id);
  }

  async function readLocal(id: string): Promise<ArrayBuffer | null> {
    const memory = memoryBytes.get(id);
    if (memory !== undefined) return memory;
    try {
      const bytes = await repository.getAudio(gameId, id);
      if (bytes instanceof ArrayBuffer && bytes.byteLength > 0) {
        diskIds.add(id);
        return bytes;
      }
    } catch {
      /* fall through to unavailable */
    }
    diskIds.delete(id);
    return null;
  }

  async function persist(id: string, bytes: ArrayBuffer): Promise<boolean> {
    try {
      const result = await repository.putAudio(gameId, id, bytes);
      if (result?.ok) {
        storedIds.add(id);
        return true;
      }
    } catch {
      /* in-memory fallback below */
    }
    memoryBytes.set(id, bytes);
    return false;
  }

  async function forget(id: string): Promise<void> {
    memoryBytes.delete(id);
    storedIds.delete(id);
    diskIds.delete(id);
    downloading.delete(id);
    progressById.delete(id);
    fetching.delete(id);
    attempted.delete(id);
    try { await repository.removeAudio(gameId, id); } catch { /* best effort */ }
    notify();
  }

  async function refreshAvailability(): Promise<void> {
    try {
      const ids = await repository.listAudio(gameId);
      if (destroyed) return;
      diskIds.clear();
      for (const id of ids) if (typeof id === 'string') diskIds.add(id);
    } catch {
      /* keep whatever was already known */
    }
    availabilityLoaded = true;
    await reconcile();
    notify();
  }

  // ── Web Audio graph ────────────────────────────────────────────────────────────────
  function ensureGraph(): Graph | null {
    if (graphAttempted) return graph;
    graphAttempted = true;
    const context = createContext();
    if (context === null || context === undefined) return null;
    try {
      const source = context.createMediaElementSource(audio);
      const shared = context.createGain();
      const limiter = context.createDynamicsCompressor();
      const local = context.createGain();
      source.connect(shared);
      shared.connect(limiter);
      limiter.connect(local);
      local.connect(context.destination);
      if (limiter.threshold !== undefined) limiter.threshold.value = -6;
      if (limiter.knee !== undefined) limiter.knee.value = 0;
      if (limiter.ratio !== undefined) limiter.ratio.value = 20;
      if (limiter.attack !== undefined) limiter.attack.value = 0.003;
      if (limiter.release !== undefined) limiter.release.value = 0.25;
      graph = { context, shared, limiter, local };
      return graph;
    } catch {
      try { context.close(); } catch { /* ignore */ }
      return null;
    }
  }

  function effectiveGain(view: AudioSessionView | undefined): number {
    if (gainOverride !== null) return gainOverride;
    const trackId = view?.currentTrackId ?? null;
    if (view === undefined || trackId === null) return 100;
    return trackFor(view, trackId)?.gain ?? 100;
  }

  function applyGains(view: AudioSessionView | undefined = audioView()): void {
    if (destroyed) return;
    const shared = effectiveGain(view) / 100;
    const local = localVolume / 100;
    if (graph !== null) {
      ramp(graph.shared.gain, shared, graph.context);
      ramp(graph.local.gain, local, graph.context);
      try { audio.volume = 1; } catch { /* ignore */ }
      return;
    }
    try { audio.volume = Math.min(1, shared * local); } catch { /* ignore */ }
  }

  // ── element/source lifecycle ───────────────────────────────────────────────────────
  function elementPositionMs(): number {
    const seconds = audio.currentTime;
    if (!Number.isFinite(seconds) || seconds < 0) return 0;
    return Math.round(seconds * 1000);
  }

  function expectedPosition(view: AudioSessionView, track: AudioTrack): number {
    // `view.startedAt` is the moment the shared position applies; the session computes it
    // including AUDIO_LEAD_MS, so it is never added a second time here.
    const elapsed = view.playing && view.startedAt !== null ? Math.max(0, now() - view.startedAt) : 0;
    return clamp(Math.round(view.positionMs + elapsed), 0, track.durationMs);
  }

  function currentPosition(view: AudioSessionView, track: AudioTrack): number {
    if (loadedId !== track.id) return expectedPosition(view, track);
    if (pendingSeekMs !== null) return clamp(pendingSeekMs, 0, track.durationMs);
    return clamp(elementPositionMs(), 0, track.durationMs);
  }

  function currentElement(): boolean {
    return loadedId !== null && !audio.paused && !audio.ended;
  }

  function seekElement(ms: number): void {
    pendingSeekMs = ms;
    try {
      audio.currentTime = ms / 1000;
      pendingSeekMs = null;
    } catch {
      /* applied on loadedmetadata */
    }
  }

  function applyPendingSeek(): void {
    if (pendingSeekMs === null) return;
    const target = pendingSeekMs;
    pendingSeekMs = null;
    try { audio.currentTime = target / 1000; } catch { /* ignore */ }
  }

  function detachSource(): void {
    if (loadedId === null && objectUrl === null) return;
    if (objectUrl !== null) {
      try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
      objectUrl = null;
    }
    loadedId = null;
    pendingSeekMs = null;
    try { audio.pause(); } catch { /* ignore */ }
    try { audio.removeAttribute('src'); } catch { /* ignore */ }
    try { audio.load(); } catch { /* ignore */ }
  }

  function pauseElement(): void {
    if (!audio.paused) {
      try { audio.pause(); } catch { /* ignore */ }
    }
  }

  async function loadCurrent(trackId: string, track: AudioTrack): Promise<void> {
    loadingId = trackId;
    try {
      const bytes = await readLocal(trackId);
      if (destroyed || audioView()?.currentTrackId !== trackId) return;
      if (bytes === null) {
        maybeAutoFetch();
        return;
      }
      detachSource();
      loadedId = trackId;
      const buffer = bytes;
      let url: string | null = null;
      try {
        if (typeof URL.createObjectURL === 'function') url = URL.createObjectURL(new Blob([buffer], { type: track.type }));
      } catch {
        url = null;
      }
      objectUrl = url;
      if (url !== null) {
        try { audio.src = url; } catch { /* ignore */ }
      }
      try { audio.load(); } catch { /* ignore */ }
      ensureGraph();
      applyGains();
      const view = audioView();
      if (view !== undefined && view.currentTrackId === trackId) {
        seekElement(expectedPosition(view, track));
      }
    } finally {
      if (loadingId === trackId) loadingId = null;
    }
    await reconcile();
    notify();
  }

  // ── autoplay and playback reconciliation ──────────────────────────────────────────
  function blockSound(): void {
    needsSound = true;
    notify();
  }

  async function attemptPlay(force = false): Promise<void> {
    if (destroyed) return;
    const view = audioView();
    if (view === undefined || view.currentTrackId === null || loadedId !== view.currentTrackId) return;
    if (!view.connected || !view.playing) return;
    if (!force && needsSound) return;
    const token = ++playAttempt;
    const active = ensureGraph();
    if (active !== null) {
      if (active.context.state !== 'running') {
        try { await active.context.resume(); } catch { /* blocked */ }
        if (destroyed || token !== playAttempt) return;
      }
      if (active.context.state !== 'running') {
        blockSound();
        return;
      }
    }
    try {
      await audio.play();
    } catch {
      if (!destroyed && token === playAttempt) blockSound();
      return;
    }
    if (destroyed || token !== playAttempt) return;
    // A resolved promise with a still-paused element is another blocked-autoplay signal.
    if (audio.paused) {
      blockSound();
      return;
    }
    needsSound = false;
    notify();
  }

  function durationOfView(view: AudioSessionView): number {
    return view.currentTrackId === null ? 0 : trackFor(view, view.currentTrackId)?.durationMs ?? 0;
  }

  function reconcilePlayback(): void {
    if (destroyed) return;
    const view = audioView();
    if (view === undefined) {
      pauseElement();
      return;
    }
    const trackId = view.currentTrackId;
    if (trackId === null) {
      pauseElement();
      detachSource();
      return;
    }
    if (isTombstoned(trackId)) {
      pauseElement();
      detachSource();
      return;
    }
    const track = trackFor(view, trackId);
    if (track === undefined) {
      pauseElement();
      return;
    }
    if (!hasLocal(trackId)) {
      pauseElement();
      if (loadedId === trackId) detachSource();
      maybeAutoFetch();
      return;
    }
    if (loadedId !== trackId) {
      if (loadingId !== trackId) void loadCurrent(trackId, track);
      pauseElement();
      return;
    }

    const expected = expectedPosition(view, track);
    const startAt = view.startedAt ?? (view.playing ? now() : null);
    const shouldPlay = view.connected && view.playing && startAt !== null && now() >= startAt;

    if (!shouldPlay) {
      pauseElement();
      if (Math.abs(elementPositionMs() - expected) > AUDIO_DRIFT_MS) seekElement(expected);
      return;
    }

    const drift = Math.abs(elementPositionMs() - expected);
    if (drift > AUDIO_DRIFT_MS) {
      // Seeking also resets a browser's ended flag, which is what lets a shared restart
      // command (position 0) revive a track whose element stopped at the duration.
      seekElement(expected);
    } else if (elementPositionMs() >= track.durationMs) {
      // The shared anchor still points at the end: wait for an explicit restart command.
      return;
    }
    if (audio.paused && !needsSound) void attemptPlay();

    applyGains(view);
  }

  async function reconcile(): Promise<void> {
    reconcilePlayback();
  }

  // ── incoming/outgoing transfers ────────────────────────────────────────────────────
  function maybeAutoFetch(): void {
    if (!availabilityLoaded || destroyed) return;
    const view = audioView();
    if (view === undefined || !view.connected || view.currentTrackId === null) return;
    const id = view.currentTrackId;
    if (hasLocal(id) || attempted.has(id) || fetching.has(id)) return;
    void fetchTrack(id, false);
  }

  let incoming: Promise<void> = Promise.resolve();
  function enqueueFetch(run: () => Promise<void>): Promise<void> {
    const next = incoming.then(run);
    incoming = next.catch(() => {});
    return next;
  }

  async function fetchTrack(id: string, force: boolean): Promise<void> {
    if (destroyed || hasLocal(id) || isTombstoned(id)) return;
    if (!force && attempted.has(id)) return;
    if (fetching.has(id)) return;
    attempted.add(id);
    fetching.add(id);
    downloading.add(id);
    progressById.set(id, 0);
    notify();
    // One logical incoming transfer: a holder request queues behind the active one while
    // duplicate requests for the same id are rejected above.
    await enqueueFetch(async () => {
      let accepted = false;
      try {
        const holders = await session.requestAudioHolders(id);
        if (destroyed) return;
        if (holders.length === 0) {
          statusMessage ??= UNAVAILABLE_MESSAGE;
          return;
        }
        if (statusMessage === UNAVAILABLE_MESSAGE) statusMessage = null;
        accepted = await session.requestAudioTrack(id, holders[0]);
        if (!accepted) statusMessage ??= 'The participant with this file could not send it.';
      } catch {
        statusMessage ??= 'That track could not be fetched.';
      } finally {
        fetching.delete(id);
        if (!accepted || hasLocal(id)) {
          downloading.delete(id);
          if (!hasLocal(id)) progressById.delete(id);
        }
        notify();
      }
    });
  }

  async function receive(bytes: Uint8Array, meta: AudioTransferMeta, _peerId: string): Promise<void> {
    if (destroyed) return;
    if (isTombstoned(meta.trackId)) return;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > AUDIO_BYTES || bytes.byteLength !== meta.size) {
      statusMessage = 'Incoming audio did not match its declared size.';
      notify();
      return;
    }
    if (hasLocal(meta.trackId)) {
      downloading.delete(meta.trackId);
      progressById.delete(meta.trackId);
      await reconcile();
      notify();
      return;
    }
    if (receiving.has(meta.trackId)) return;
    receiving.add(meta.trackId);
    downloading.add(meta.trackId);
    progressById.set(meta.trackId, 0);
    notify();
    try {
      const hash = await sha256Hex(bytes);
      if (hash !== meta.trackId) {
        statusMessage = 'Incoming audio failed its integrity check.';
        return;
      }
      if (destroyed || isTombstoned(meta.trackId)) return;
      const buffer = toArrayBuffer(bytes);
      const stored = await persist(meta.trackId, buffer);
      if (isTombstoned(meta.trackId)) {
        // A tombstone that arrived while hashing/storing wins; never keep those bytes.
        await forget(meta.trackId);
        return;
      }
      if (!stored) statusMessage = PERSISTENCE_WARNING;
      await reconcile();
    } catch {
      statusMessage = 'Incoming audio could not be verified or stored.';
    } finally {
      receiving.delete(meta.trackId);
      downloading.delete(meta.trackId);
      progressById.delete(meta.trackId);
      notify();
    }
  }

  let outgoing: Promise<void> = Promise.resolve();
  function enqueueSend(run: () => Promise<void>): Promise<void> {
    const next = outgoing.then(run);
    outgoing = next.catch(() => {});
    return next;
  }

  async function broadcast(bytes: ArrayBuffer, meta: AudioTransferMeta): Promise<void> {
    const view = audioView();
    if (view === undefined || !view.connected) return;
    await enqueueSend(async () => { await session.sendAudioTrack(new Uint8Array(bytes), meta); });
  }

  // ── session lifecycle ──────────────────────────────────────────────────────────────
  function syncGainOverride(view: AudioSessionView | undefined): void {
    if (gainOverride === null) return;
    const track = view === undefined || view.currentTrackId === null ? undefined : trackFor(view, view.currentTrackId);
    if (track === undefined || track.gain !== gainOverride) gainOverride = null;
  }

  function purgeTombstones(view: AudioSessionView): void {
    for (const id of view.tombstones) {
      tombstoneIds.add(id);
      if (purged.has(id)) continue;
      purged.add(id);
      if (loadedId === id) {
        pauseElement();
        detachSource();
      }
      void forget(id);
    }
  }

  function onSessionChanged(): void {
    if (destroyed) return;
    const view = audioView();
    const connected = view?.connected ?? false;
    if (view !== undefined) {
      for (const id of view.tombstones) tombstoneIds.add(id);
      purgeTombstones(view);
      syncGainOverride(view);
      if (!view.playing || !view.connected) needsSound = false;
    }
    registerTransfers();
    if (connected && !lastConnected) {
      attempted.clear();
      void refreshAvailability();
    }
    if (!connected) {
      // A lost channel cannot finish an incoming transfer; do not keep advertising it.
      downloading.clear();
      progressById.clear();
    }
    lastConnected = connected;
    void reconcile();
    notify();
  }

  function onLoadedMetadata(): void {
    applyPendingSeek();
    void reconcile();
    notify();
  }

  function onEnded(): void {
    notify();
  }

  function onPlaybackError(): void {
    if (loadedId !== null) statusMessage = 'This browser could not play that audio file.';
    notify();
  }

  // ── subscriptions/handlers ─────────────────────────────────────────────────────────
  const unsubscribers: Array<() => void> = [session.subscribe(onSessionChanged)];
  const transferUnsubscribers: Array<() => void> = [];
  let transfersRegistered = false;

  /**
   * A joining session may not have a workspace (and therefore no audio session) when this
   * controller is created; its bootstrap creates one later. Transfer handlers are attached
   * on the first view that exposes audio so a late workspace is not left without a holder.
   */
  function registerTransfers(): void {
    if (transfersRegistered || destroyed) return;
    // Set the flag before reading the view: `getView()` may refresh and emit, and a
    // reentrant notification must not attach a second copy of every handler.
    transfersRegistered = true;
    if (audioView() === undefined) {
      transfersRegistered = false;
      return;
    }
    transferUnsubscribers.push(session.onAudioTrack((bytes, meta, peerId) => receive(bytes, meta, peerId)));
    transferUnsubscribers.push(session.onAudioProgress((fraction, meta) => {
      if (destroyed || hasLocal(meta.trackId) || isTombstoned(meta.trackId)) return;
      downloading.add(meta.trackId);
      progressById.set(meta.trackId, clamp(fraction, 0, 1));
      notifyProgress();
    }));
    transferUnsubscribers.push(session.onAudioWho((trackId) => {
      if (isTombstoned(trackId)) return false;
      if (hasLocal(trackId)) return true;
      return (async () => {
        try {
          const present = await repository.hasAudio(gameId, trackId);
          if (present) diskIds.add(trackId);
          return present;
        } catch {
          return false;
        }
      })();
    }));
    transferUnsubscribers.push(session.onAudioFetch((trackId, peerId) => (async () => {
      if (isTombstoned(trackId)) return false;
      const track = trackFor(audioView(), trackId);
      const bytes = await readLocal(trackId);
      if (destroyed || track === undefined || bytes === null) return false;
      const meta: AudioTransferMeta = { trackId, name: track.name, type: track.type, size: bytes.byteLength };
      try {
        await enqueueSend(async () => {
          await session.sendAudioTrack(new Uint8Array(bytes), meta, peerId);
        });
        return true;
      } catch {
        statusMessage = SEND_FAILURE;
        notify();
        return false;
      }
    })()));
    transferUnsubscribers.push(session.onAudioPosition((trackId) => {
      const view = audioView();
      if (view === undefined || view.currentTrackId !== trackId || loadedId !== trackId) return null;
      return { trackId, playing: currentElement(), positionMs: elementPositionMs() };
    }));
  }

  audio.addEventListener?.('loadedmetadata', onLoadedMetadata);
  audio.addEventListener?.('ended', onEnded);
  audio.addEventListener?.('error', onPlaybackError);

  const visibilityTarget = typeof document === 'undefined' ? null : document;
  const onVisibility = () => {
    if (visibilityTarget?.visibilityState === 'hidden') return;
    void reconcile();
    notify();
  };
  visibilityTarget?.addEventListener('visibilitychange', onVisibility);

  const timer = setInterval(() => {
    void reconcile();
    notify();
  }, TICK_MS);
  (timer as { unref?: () => void }).unref?.();

  // Prime the initial state: availability first, then playback for a restored command.
  registerTransfers();
  const initialView = audioView();
  lastConnected = initialView?.connected ?? false;
  void refreshAvailability();
  onSessionChanged();

  function trackEnded(view: AudioSessionView, track: AudioTrack): boolean {
    if (view.currentTrackId !== track.id) return false;
    // Derive the end from the playhead, not a stale element `ended` flag: a seek back to
    // zero (shared restart or a new select) must clear it immediately.
    return currentPosition(view, track) >= track.durationMs;
  }

  function panelView(): AudioPanelView {
    const view = audioView();
    const localPlayerId = session.getView().localPlayerId;
    const tracks = (view?.tracks ?? []).map((track): AudioTrackView => ({
      ...track,
      available: hasLocal(track.id),
      downloading: downloading.has(track.id),
      progress: progressById.get(track.id) ?? 0,
      current: view?.currentTrackId === track.id,
      ended: view !== undefined && trackEnded(view, track),
    }));
    const current = view !== undefined && view.currentTrackId !== null ? trackFor(view, view.currentTrackId) : undefined;
    const currentId = view?.currentTrackId ?? null;
    const playing = currentId !== null && loadedId === currentId && currentElement();
    const positionMs = view !== undefined && current !== undefined ? currentPosition(view, current) : 0;
    const usageBytes = (view?.tracks ?? []).reduce((total, track) => total + (hasLocal(track.id) ? track.size : 0), 0);
    return {
      tracks,
      currentTrackId: currentId,
      playing,
      positionMs,
      durationMs: current?.durationMs ?? 0,
      gain: effectiveGain(view),
      localVolume,
      needsSound,
      connected: view?.connected ?? false,
      canAdd: localPlayerId !== null,
      canControl: view?.canControl ?? false,
      canRemove: localPlayerId !== null,
      usageBytes,
      status: view !== undefined && !view.connected && currentId !== null ? 'Music paused: disconnected.' : statusMessage,
    };
  }

  const actions: AudioActions = {
    async add(file: File): Promise<void> {
      if (destroyed) return;
      statusMessage = null;
      const deps: PrepareAudioDeps = {};
      if (options.probeDuration !== undefined) deps.probeDuration = options.probeDuration;
      if (options.canPlay !== undefined) deps.canPlay = options.canPlay;
      try {
        // Validate, hash and read before touching the shared library: a rejected file
        // must not publish metadata that no peer can ever fetch from this browser.
        const prepared = await prepareAudioFile(file, deps);
        if (destroyed) return;
        const stored = await persist(prepared.input.id, prepared.bytes);
        if (destroyed) return;
        if (!stored) statusMessage = PERSISTENCE_WARNING;
        const accepted = session.addTrack(prepared.input);
        if (!accepted) {
          statusMessage ??= session.getView().error ?? 'Choose your player first.';
        } else {
          try {
            await broadcast(prepared.bytes, prepared.meta);
          } catch {
            statusMessage ??= SEND_FAILURE;
          }
        }
        await reconcile();
      } catch (error) {
        statusMessage = error instanceof Error && error.message ? error.message : 'The audio file could not be added.';
      }
      notify();
    },

    remove(id: string): void {
      if (destroyed) return;
      const track = trackFor(audioView(), id);
      if (!confirmAction(`Remove “${track?.name ?? 'this track'}” from the game?`)) return;
      session.removeTrack(id);
    },

    select(id: string): void {
      if (destroyed) return;
      session.selectTrack(id);
    },

    toggle(): void {
      if (destroyed) return;
      const view = audioView();
      if (view === undefined || view.currentTrackId === null) return;
      if (needsSound) {
        void actions.enableSound();
        return;
      }
      const current = trackFor(view, view.currentTrackId);
      const ended = current !== undefined && trackEnded(view, current);
      // A track whose local element ended restarts from zero: the session's play command
      // already converts an at-duration anchor into a 0 ms position.
      if (view.playing && !ended) session.stopTrack();
      else session.playTrack();
    },

    seek(ms: number): void {
      if (destroyed) return;
      const view = audioView();
      if (view === undefined || view.currentTrackId === null) return;
      const duration = durationOfView(view);
      const target = clamp(Math.round(ms), 0, duration);
      if (loadedId === view.currentTrackId) seekElement(target);
      session.seekTrack(target);
      notify();
    },

    setGain(value: number): void {
      if (destroyed) return;
      const gain = clamp(Math.round(value), 0, 200);
      gainOverride = gain;
      const view = audioView();
      const id = view?.currentTrackId ?? null;
      if (id !== null) {
        const accepted = session.setTrackGain(id, gain);
        if (!accepted) gainOverride = null;
      }
      applyGains(view);
      notify();
    },

    setLocalVolume(value: number): void {
      if (destroyed) return;
      localVolume = clamp(Math.round(value), 0, 100);
      persistMaster();
      applyGains();
      notify();
    },

    async enableSound(): Promise<void> {
      if (destroyed) return;
      const view = audioView();
      if (view === undefined || view.currentTrackId === null) {
        needsSound = false;
        notify();
        return;
      }
      const active = ensureGraph();
      if (active !== null && active.context.state !== 'running') {
        try { await active.context.resume(); } catch { /* not required for paused playback */ }
      }
      if (!view.connected || !view.playing) {
        needsSound = false;
        notify();
        return;
      }
      const track = trackFor(view, view.currentTrackId);
      if (track !== undefined) seekElement(expectedPosition(view, track));
      await attemptPlay(true);
      if (!destroyed && !audio.paused) {
        needsSound = false;
        notify();
      }
    },

    async retry(id: string): Promise<void> {
      if (destroyed) return;
      attempted.delete(id);
      statusMessage = null;
      await fetchTrack(id, true);
      notify();
    },
  };

  return {
    getView: panelView,
    actions,
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(timer);
      visibilityTarget?.removeEventListener('visibilitychange', onVisibility);
      audio.removeEventListener?.('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener?.('ended', onEnded);
      audio.removeEventListener?.('error', onPlaybackError);
      for (const unsubscribe of [...unsubscribers.splice(0), ...transferUnsubscribers.splice(0)]) {
        try { unsubscribe(); } catch { /* ignore */ }
      }
      pauseElement();
      detachSource();
      try { graph?.context.close(); } catch { /* ignore */ }
      graph = null;
      if (ownsElement) {
        try { audio.remove(); } catch { /* ignore */ }
        try { audio.parentNode?.removeChild(audio); } catch { /* ignore */ }
      }
      listeners.clear();
    },
  };
}
