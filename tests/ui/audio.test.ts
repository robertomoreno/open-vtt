// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createAudioTrack,
  sha256Hex,
  type AudioPositionBody,
  type AudioTrack,
  type AudioTransferMeta,
} from '../../src/game/audio';
import { emptyAudioSessionView, type AudioSessionView } from '../../src/session/audio';
import type { PeerSessionView } from '../../src/session/peer-types';
import {
  createAudioController,
  type AudioController,
  type AudioSessionPort,
  type AudioStorePort,
} from '../../src/ui/audio';

const AT = '2026-11-10T10:00:00.000Z';
const ID = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

type Fn = ReturnType<typeof vi.fn>;

function makeTrack(id = ID, name = 'Theme.wav', size = 4, durationMs = 6000): AudioTrack {
  return createAudioTrack({ id, name, type: 'audio/wav', size, durationMs }, 'alex', AT);
}

function view(overrides: Partial<AudioSessionView> = {}): AudioSessionView {
  return {
    ...emptyAudioSessionView(),
    tracks: [makeTrack()],
    currentTrackId: ID,
    connected: true,
    canControl: true,
    ...overrides,
  };
}

type FakeSession = AudioSessionPort & {
  receive(bytes: Uint8Array, meta: AudioTransferMeta, peerId: string): Promise<void>;
  fetch(trackId: string, peerId: string): Promise<boolean>;
  who(trackId: string, peerId: string): Promise<boolean>;
  position(trackId: string, peerId: string): AudioPositionBody | null | Promise<AudioPositionBody | null>;
  progress(fraction: number, meta: AudioTransferMeta, peerId: string): void;
  setAudio(next: AudioSessionView | undefined): void;
  setPeers(onlinePlayerIds: string[], unseatedParticipantCount?: number): void;
  emit(): void;
};

function peerView(
  audio: AudioSessionView | undefined,
  localPlayerId: string | null,
  onlinePlayerIds: string[] = [],
  unseatedParticipantCount = 0,
): PeerSessionView {
  return {
    game: null,
    phase: 'ready',
    localPlayerId,
    onlinePlayerIds,
    priorityParticipantId: null,
    canCreatePlayer: false,
    canRoll: localPlayerId !== null,
    canChat: false,
    messages: [],
    liveImages: [],
    hasRecovery: false,
    hasRoomLink: false,
    unseatedParticipantCount,
    conflicts: [],
    error: null,
    connectionError: null,
    audio,
    saveGeneration: 0,
  };
}

function fakeSession(options: Partial<AudioSessionPort> & { view?: AudioSessionView | undefined; localPlayerId?: string | null } = {}): FakeSession {
  const listeners = new Set<() => void>();
  const callbacks: {
    track?: (bytes: Uint8Array, meta: AudioTransferMeta, peerId: string) => void;
    fetch?: (trackId: string, peerId: string) => boolean | Promise<boolean>;
    who?: (trackId: string, peerId: string) => boolean | Promise<boolean>;
    position?: (trackId: string, peerId: string) => AudioPositionBody | null | Promise<AudioPositionBody | null>;
    progress?: (fraction: number, meta: AudioTransferMeta, peerId: string) => void;
  } = {};
  const hasView = Object.prototype.hasOwnProperty.call(options, 'view');
  let audio = hasView ? options.view : view();
  let localPlayerId = options.localPlayerId === undefined ? 'alex' : options.localPlayerId;
  let onlinePlayerIds: string[] = [];
  let unseatedParticipantCount = 0;
  const listener = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
  const session = {
    getView: vi.fn(() => peerView(audio, localPlayerId, onlinePlayerIds, unseatedParticipantCount)),
    subscribe: vi.fn(listener),
    addTrack: vi.fn(() => true),
    removeTrack: vi.fn(),
    setTrackGain: vi.fn(() => true),
    selectTrack: vi.fn(),
    playTrack: vi.fn(),
    stopTrack: vi.fn(),
    seekTrack: vi.fn(),
    sendAudioTrack: vi.fn(async () => {}),
    requestAudioHolders: vi.fn(async () => [] as string[]),
    requestAudioTrack: vi.fn(async () => false),
    requestAudioPosition: vi.fn(async () => null),
    onAudioTrack: vi.fn((fn: (bytes: Uint8Array, meta: AudioTransferMeta, peerId: string) => void) => {
      callbacks.track = fn;
      return () => { if (callbacks.track === fn) callbacks.track = undefined; };
    }),
    onAudioFetch: vi.fn((fn: (trackId: string, peerId: string) => boolean | Promise<boolean>) => {
      callbacks.fetch = fn;
      return () => { if (callbacks.fetch === fn) callbacks.fetch = undefined; };
    }),
    onAudioWho: vi.fn((fn: (trackId: string, peerId: string) => boolean | Promise<boolean>) => {
      callbacks.who = fn;
      return () => { if (callbacks.who === fn) callbacks.who = undefined; };
    }),
    onAudioPosition: vi.fn((fn: (trackId: string, peerId: string) => AudioPositionBody | null | Promise<AudioPositionBody | null>) => {
      callbacks.position = fn;
      return () => { if (callbacks.position === fn) callbacks.position = undefined; };
    }),
    onAudioProgress: vi.fn((fn: (fraction: number, meta: AudioTransferMeta, peerId: string) => void) => {
      callbacks.progress = fn;
      return () => { if (callbacks.progress === fn) callbacks.progress = undefined; };
    }),
  };
  const { view: _view, localPlayerId: _localPlayerId, ...overrides } = options;
  Object.assign(session, overrides);
  return Object.assign(session, {
    async receive(bytes: Uint8Array, meta: AudioTransferMeta, peerId: string) {
      await callbacks.track?.(bytes, meta, peerId);
    },
    async fetch(trackId: string, peerId: string) {
      return (await callbacks.fetch?.(trackId, peerId)) ?? false;
    },
    async who(trackId: string, peerId: string) {
      return (await callbacks.who?.(trackId, peerId)) ?? false;
    },
    async position(trackId: string, peerId: string) {
      return (await callbacks.position?.(trackId, peerId)) ?? null;
    },
    progress(fraction: number, meta: AudioTransferMeta, peerId: string) {
      callbacks.progress?.(fraction, meta, peerId);
    },
    setAudio(next: AudioSessionView | undefined) {
      audio = next;
    },
    setPeers(next: string[], unseated = 0) {
      onlinePlayerIds = next;
      unseatedParticipantCount = unseated;
    },
    emit() {
      for (const fn of [...listeners]) fn();
    },
  }) as unknown as FakeSession;
}

type FakeStore = AudioStorePort & {
  putAudio: Fn;
  getAudio: Fn;
  hasAudio: Fn;
  removeAudio: Fn;
  removeGameAudio: Fn;
  listAudio: Fn;
};

function fakeStore(overrides: Partial<AudioStorePort> = {}, options: { seed?: string[] } = {}): FakeStore {
  const bytes = new Map<string, ArrayBuffer>();
  for (const id of options.seed ?? []) bytes.set(id, new Uint8Array([1, 2, 3, 4]).buffer);
  const store = {
    putAudio: vi.fn(async (_game: string, id: string, data: ArrayBuffer) => { bytes.set(id, data); return { ok: true }; }),
    getAudio: vi.fn(async (_game: string, id: string) => bytes.get(id) ?? null),
    hasAudio: vi.fn(async (_game: string, id: string) => bytes.has(id)),
    removeAudio: vi.fn(async (_game: string, id: string) => { bytes.delete(id); }),
    removeGameAudio: vi.fn(async () => {}),
    listAudio: vi.fn(async () => [...bytes.keys()]),
    ...overrides,
  };
  return store as unknown as FakeStore;
}

type FakeAudio = Omit<HTMLAudioElement, 'duration' | 'currentTime' | 'paused' | 'ended'> & {
  duration: number;
  currentTime: number;
  paused: boolean;
  ended: boolean;
  play: Fn;
  pause: Fn;
  load: Fn;
  removeAttribute: Fn;
};

function fakeAudio(): FakeAudio {
  const audio = new EventTarget() as unknown as Record<string, unknown>;
  audio.id = '';
  audio.hidden = false;
  audio.preload = '';
  audio.src = '';
  audio.currentTime = 0;
  audio.duration = 0;
  audio.paused = true;
  audio.ended = false;
  audio.volume = 1;
  audio.play = vi.fn(async () => { audio.paused = false; audio.ended = false; });
  audio.pause = vi.fn(() => { audio.paused = true; });
  audio.load = vi.fn(() => {});
  audio.removeAttribute = vi.fn((name: string) => { if (name === 'src') audio.src = ''; });
  return audio as unknown as FakeAudio;
}

type FakeContext = AudioContext & {
  state: AudioContextState;
  resume: Fn;
  close: Fn;
  createMediaElementSource: Fn;
  createGain: Fn;
  createDynamicsCompressor: Fn;
};

function fakeContext(): FakeContext {
  const parameter = () => ({ value: 1, setTargetAtTime: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() });
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const context = {
    state: 'running' as AudioContextState,
    currentTime: 0,
    destination: {},
    createMediaElementSource: vi.fn(() => node()),
    createGain: vi.fn(() => ({ ...node(), gain: parameter() })),
    createDynamicsCompressor: vi.fn(() => ({
      ...node(), threshold: parameter(), knee: parameter(), ratio: parameter(), attack: parameter(), release: parameter(),
    })),
    resume: vi.fn(async () => { context.state = 'running'; }),
    close: vi.fn(async () => { context.state = 'closed'; }),
  };
  return context as unknown as FakeContext;
}

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
let createObjectURL: Fn;
let revokeObjectURL: Fn;

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  createObjectURL = vi.fn(() => 'blob:audio');
  revokeObjectURL = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL });
});

const built: AudioController[] = [];

function build(options: Parameters<typeof createAudioController>[0]): AudioController {
  const controller = createAudioController(options);
  built.push(controller);
  return controller;
}

afterEach(() => {
  for (const controller of built.splice(0)) controller.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalCreateObjectURL) URL.createObjectURL = originalCreateObjectURL;
  else delete (URL as unknown as Record<string, unknown>).createObjectURL;
  if (originalRevokeObjectURL) URL.revokeObjectURL = originalRevokeObjectURL;
  else delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  document.body.innerHTML = '';
});

it('adds a track by storing bytes before publishing metadata and sending to peers', async () => {
  const session = fakeSession({ view: view({ currentTrackId: null }) });
  const store = fakeStore();
  const c = build({
    session,
    repository: store,
    gameId: 'game',
    createAudio: fakeAudio,
    createContext: fakeContext,
    probeDuration: async () => 6000,
    canPlay: () => true,
  });

  await c.actions.add(new File([new Uint8Array(4)], 'theme.wav', { type: 'audio/wav' }));

  expect(store.putAudio).toHaveBeenCalledWith('game', expect.any(String), expect.any(ArrayBuffer));
  expect(store.putAudio.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(session.addTrack).mock.invocationCallOrder[0]);
  expect(session.addTrack).toHaveBeenCalled();
  expect(session.sendAudioTrack).toHaveBeenCalled();
});

it('does not rebroadcast a file that is already in the library', async () => {
  const session = fakeSession({ view: view({ currentTrackId: null }) });
  const store = fakeStore();
  const c = build({
    session,
    repository: store,
    gameId: 'game',
    createAudio: fakeAudio,
    createContext: fakeContext,
    probeDuration: async () => 6000,
    canPlay: () => true,
  });
  const file = new File([new Uint8Array(4)], 'theme.wav', { type: 'audio/wav' });

  await c.actions.add(file);
  const id = vi.mocked(session.addTrack).mock.calls[0][0].id;
  vi.mocked(session.addTrack).mockClear();
  session.setAudio(view({ tracks: [makeTrack(id, 'theme.wav', 4)], currentTrackId: null }));
  session.emit();

  await c.actions.add(file);
  expect(session.addTrack).not.toHaveBeenCalled();
  expect(session.sendAudioTrack).toHaveBeenCalledTimes(1);
  expect(c.getView().status).toBe('Already in the library.');
});

it('surfaces the removal message when re-adding tombstoned bytes', async () => {
  const file = new File([new Uint8Array(4)], 'theme.wav', { type: 'audio/wav' });
  const preparedId = await sha256Hex(new Uint8Array(4));
  const session = fakeSession({ view: view({ tracks: [], tombstones: [preparedId], currentTrackId: null }) });
  const c = build({
    session,
    repository: fakeStore(),
    gameId: 'game',
    createAudio: fakeAudio,
    createContext: fakeContext,
    probeDuration: async () => 6000,
    canPlay: () => true,
  });

  await c.actions.add(file);
  expect(session.addTrack).not.toHaveBeenCalled();
  expect(c.getView().status).toMatch(/removed/i);
});

it('stores verified incoming bytes and rejects a hash mismatch', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const id = await sha256Hex(bytes);
  // Both ids are active library tracks, so the reference gate accepts the payloads and
  // the integrity check is what rejects the second one.
  const session = fakeSession({ view: view({ tracks: [makeTrack(id, 'x', 3), makeTrack()], currentTrackId: null }) });
  const store = fakeStore();
  const c = build({ session, repository: store, gameId: 'game', createAudio: fakeAudio, createContext: fakeContext });

  await session.receive(bytes, { trackId: id, name: 'x', type: 'audio/mpeg', size: 3 }, 'peer-a');
  expect(store.putAudio).toHaveBeenCalledWith('game', id, expect.any(ArrayBuffer));

  await session.receive(bytes, { trackId: ID, name: 'x', type: 'audio/mpeg', size: 3 }, 'peer-a');
  expect(c.getView().status).toMatch(/integrity|hash/i);
});

it('rotates to the next holder after corrupt bytes fail the integrity check', async () => {
  const session = fakeSession({ view: view({ tracks: [makeTrack()], currentTrackId: null }) });
  const holders = vi.mocked(session.requestAudioHolders);
  const request = vi.mocked(session.requestAudioTrack);
  holders.mockResolvedValue(['peer-a', 'peer-b']);
  request.mockResolvedValue(true);
  const c = build({ session, repository: fakeStore(), gameId: 'game', createAudio: fakeAudio, createContext: fakeContext });

  // These bytes hash to a different id, so the metadata reference gate accepts the
  // active track and the holder's answer is rejected as corrupt.
  await session.receive(new Uint8Array([9, 9, 9]), { trackId: ID, name: 'Theme.wav', type: 'audio/wav', size: 3 }, 'peer-a');
  expect(c.getView().status).toMatch(/integrity|hash/i);

  await c.actions.retry(ID);
  expect(request).toHaveBeenCalledWith(ID, 'peer-b');
});

it('deletes local bytes when a tombstone appears and stops a removed current track', async () => {
  const session = fakeSession({ view: view({ tracks: [makeTrack()], tombstones: [ID], currentTrackId: ID }) });
  const store = fakeStore({}, { seed: [ID] });
  const c = build({ session, repository: store, gameId: 'game', createAudio: fakeAudio, createContext: fakeContext });

  await vi.waitFor(() => expect(store.removeAudio).toHaveBeenCalledWith('game', ID));
  expect(c.getView().playing).toBe(false);
});

it('fetches a missing current track from a holder and shows progress', async () => {
  const session = fakeSession({ view: view({ currentTrackId: null }) });
  vi.mocked(session.requestAudioHolders).mockResolvedValue(['peer-b']);
  vi.mocked(session.requestAudioTrack).mockResolvedValue(true);
  const c = build({ session, repository: fakeStore(), gameId: 'game', createAudio: fakeAudio, createContext: fakeContext });

  await c.actions.retry(ID);

  expect(session.requestAudioTrack).toHaveBeenCalledWith(ID, 'peer-b');
});

it('uses shared gain and local master independently and persists the local master', () => {
  const storage = new Map<string, string>();
  const session = fakeSession({ view: view({ tracks: [], currentTrackId: null }) });
  const c = build({
    session,
    repository: fakeStore(),
    gameId: 'game',
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    createAudio: fakeAudio,
    createContext: fakeContext,
  });

  c.actions.setGain(160);
  expect(c.getView().gain).toBe(160);
  c.actions.setLocalVolume(20);
  expect(c.getView().localVolume).toBe(20);
  expect(storage.get('gather:audio:master')).toBe('0.2');
});

it('explains that a shared boost above 100% needs Web Audio', async () => {
  const session = fakeSession({ view: view({ tracks: [makeTrack()], currentTrackId: ID }) });
  const c = build({
    session,
    repository: fakeStore({}, { seed: [ID] }),
    gameId: 'game',
    createAudio: fakeAudio,
    createContext: () => null,
  });

  c.actions.setGain(150);
  expect(c.getView().gain).toBe(150);
  expect(c.getView().status).toMatch(/boost|unavailable/i);
});

it('shows Enable sound when playback is blocked and never claims playing', async () => {
  const audio = fakeAudio();
  audio.play.mockRejectedValue(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
  const session = fakeSession({ view: view({ playing: true, currentTrackId: ID, startedAt: 0 }) });
  const c = build({
    session,
    repository: fakeStore({}, { seed: [ID] }),
    gameId: 'game',
    now: () => 1000,
    createAudio: () => audio,
    createContext: fakeContext,
  });

  await vi.waitFor(() => expect(c.getView().needsSound).toBe(true));
  expect(c.getView().playing).toBe(false);
});

it('enableSound resumes the context, seeks to the anchor and clears the prompt', async () => {
  const audio = fakeAudio();
  audio.duration = 6;
  audio.play.mockRejectedValueOnce(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
  const context = fakeContext();
  const session = fakeSession({ view: view({ playing: true, positionMs: 2000, currentTrackId: ID, startedAt: 0 }) });
  const c = build({
    session,
    repository: fakeStore({}, { seed: [ID] }),
    gameId: 'game',
    now: () => 1000,
    createAudio: () => audio,
    createContext: () => context,
  });

  await vi.waitFor(() => expect(c.getView().needsSound).toBe(true));
  context.state = 'suspended';
  await c.actions.enableSound();

  expect(context.resume).toHaveBeenCalled();
  expect(audio.currentTime).toBe(3);
  expect(c.getView().needsSound).toBe(false);
  expect(c.getView().playing).toBe(true);
});

it('shows Enable sound when AudioContext.resume never settles', async () => {
  const audio = fakeAudio();
  audio.duration = 6;
  const context = fakeContext();
  context.state = 'suspended';
  context.resume.mockImplementation(() => new Promise(() => {}));
  const session = fakeSession({ view: view({ playing: true, currentTrackId: ID, startedAt: 0 }) });
  const c = build({
    session,
    repository: fakeStore({}, { seed: [ID] }),
    gameId: 'game',
    now: () => 1000,
    createAudio: () => audio,
    createContext: () => context,
  });

  await vi.waitFor(() => expect(c.getView().needsSound).toBe(true), { timeout: 2000 });
  expect(c.getView().playing).toBe(false);
  expect(audio.play).not.toHaveBeenCalled();
});

it('pauses on disconnect without issuing a command', async () => {
  const audio = fakeAudio();
  const session = fakeSession({ view: view({ playing: true, currentTrackId: ID, startedAt: 0 }) });
  const c = build({
    session,
    repository: fakeStore({}, { seed: [ID] }),
    gameId: 'game',
    now: () => 1000,
    createAudio: () => audio,
    createContext: fakeContext,
  });

  await vi.waitFor(() => expect(c.getView().playing).toBe(true));
  session.setAudio(view({ playing: true, currentTrackId: ID, startedAt: 0, connected: false }));
  session.emit();

  await vi.waitFor(() => expect(audio.pause).toHaveBeenCalled());
  expect(c.getView().connected).toBe(false);
  expect(c.getView().status).toMatch(/disconnected/i);
  expect(session.selectTrack).not.toHaveBeenCalled();
  expect(session.playTrack).not.toHaveBeenCalled();
  expect(session.stopTrack).not.toHaveBeenCalled();
});

it('reports usage from locally available tracks', async () => {
  const first = makeTrack(ID, 'A.wav', 1000);
  const second = makeTrack(OTHER, 'B.wav', 2000);
  const session = fakeSession({ view: view({ tracks: [first, second], currentTrackId: null }) });
  const c = build({
    session,
    repository: fakeStore({}, { seed: [ID, OTHER] }),
    gameId: 'game',
    createAudio: fakeAudio,
    createContext: fakeContext,
  });

  await vi.waitFor(() => expect(c.getView().usageBytes).toBe(3000));
});

it('auto-fetches the current track when it is missing locally', async () => {
  const session = fakeSession({ view: view({ currentTrackId: ID }) });
  vi.mocked(session.requestAudioHolders).mockResolvedValue(['peer-b']);
  vi.mocked(session.requestAudioTrack).mockResolvedValue(true);
  build({ session, repository: fakeStore(), gameId: 'game', createAudio: fakeAudio, createContext: fakeContext });

  await vi.waitFor(() => expect(session.requestAudioTrack).toHaveBeenCalledWith(ID, 'peer-b'));
});

it('retries a missing current track when a peer joins the connected room', async () => {
  const session = fakeSession({ view: view({ currentTrackId: ID }) });
  const holders = vi.mocked(session.requestAudioHolders);
  const request = vi.mocked(session.requestAudioTrack);
  holders.mockResolvedValue([]);
  request.mockResolvedValue(true);
  const c = build({ session, repository: fakeStore(), gameId: 'game', createAudio: fakeAudio, createContext: fakeContext });

  await vi.waitFor(() => expect(holders).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(c.getView().status).toMatch(/not available/i));

  holders.mockResolvedValue(['peer-c']);
  session.setPeers(['bea'], 1);
  session.emit();

  await vi.waitFor(() => expect(holders.mock.calls.filter(([id]) => id === ID)).toHaveLength(2));
  expect(request).toHaveBeenCalledWith(ID, 'peer-c');
});

it('re-probes when switching away from a failed current track and back', async () => {
  const second = makeTrack(OTHER, 'B.wav');
  const session = fakeSession({ view: view({ tracks: [makeTrack(), second], currentTrackId: ID }) });
  const holders = vi.mocked(session.requestAudioHolders);
  holders.mockResolvedValue([]);
  const c = build({ session, repository: fakeStore(), gameId: 'game', createAudio: fakeAudio, createContext: fakeContext });

  await vi.waitFor(() => expect(holders).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(c.getView().status).toMatch(/not available/i));

  session.setAudio(view({ tracks: [makeTrack(), second], currentTrackId: OTHER }));
  session.emit();
  session.setAudio(view({ tracks: [makeTrack(), second], currentTrackId: ID }));
  session.emit();

  await vi.waitFor(() => expect(holders.mock.calls.filter(([id]) => id === ID)).toHaveLength(2));
});

it('periodically re-probes with backoff while the track is still missing', async () => {
  let clock = 0;
  const session = fakeSession({ view: view({ currentTrackId: ID }) });
  const holders = vi.mocked(session.requestAudioHolders);
  const request = vi.mocked(session.requestAudioTrack);
  holders.mockResolvedValue([]);
  request.mockResolvedValue(true);
  const c = build({
    session,
    repository: fakeStore(),
    gameId: 'game',
    now: () => clock,
    createAudio: fakeAudio,
    createContext: fakeContext,
  });

  await vi.waitFor(() => expect(holders).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(c.getView().status).toMatch(/not available/i));

  holders.mockResolvedValue(['peer-b']);
  clock = 5000;
  session.emit();

  await vi.waitFor(() => expect(holders).toHaveBeenCalledTimes(2));
  expect(request).toHaveBeenCalledWith(ID, 'peer-b');
});

it('answers who and position requests from local state', async () => {
  const audio = fakeAudio();
  audio.duration = 6;
  const session = fakeSession({ view: view({ playing: false, positionMs: 1500, currentTrackId: ID }) });
  const c = build({
    session,
    repository: fakeStore({}, { seed: [ID] }),
    gameId: 'game',
    now: () => 1000,
    createAudio: () => audio,
    createContext: fakeContext,
  });

  await vi.waitFor(() => expect(audio.src).toBe('blob:audio'));
  expect(await session.who(ID, 'peer-a')).toBe(true);
  expect(await session.who(OTHER, 'peer-a')).toBe(false);

  audio.currentTime = 1.5;
  expect(c.getView().positionMs).toBe(1500);
  expect(await session.position(ID, 'peer-a')).toEqual({ trackId: ID, playing: false, positionMs: 1500 });
  expect(await session.position(OTHER, 'peer-a')).toBeNull();
});

it('answers for the shared playing state while the element is still paused during the lead', async () => {
  const audio = fakeAudio();
  audio.duration = 6;
  const session = fakeSession({ view: view({ playing: true, positionMs: 1000, currentTrackId: ID, startedAt: 1500 }) });
  build({
    session,
    repository: fakeStore({}, { seed: [ID] }),
    gameId: 'game',
    now: () => 1000,
    createAudio: () => audio,
    createContext: fakeContext,
  });

  await vi.waitFor(() => expect(audio.src).toBe('blob:audio'));
  expect(audio.paused).toBe(true);
  expect(await session.position(ID, 'peer-a')).toEqual({ trackId: ID, playing: true, positionMs: 1000 });
});

it('sends targeted bytes when a peer requests a track', async () => {
  const session = fakeSession({ view: view({ tracks: [makeTrack()], currentTrackId: null }) });
  const c = build({
    session,
    repository: fakeStore({}, { seed: [ID] }),
    gameId: 'game',
    createAudio: fakeAudio,
    createContext: fakeContext,
  });

  await vi.waitFor(async () => expect(await session.who(ID, 'peer-a')).toBe(true));
  const accepted = await session.fetch(ID, 'peer-b');

  expect(accepted).toBe(true);
  expect(session.sendAudioTrack).toHaveBeenCalledWith(
    expect.any(Uint8Array),
    expect.objectContaining({ trackId: ID }),
    'peer-b',
  );
  expect(c.getView().tracks[0]?.available).toBe(true);
});

it('acknowledges a fetch before the queued send finishes', async () => {
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  const session = fakeSession({ view: view({ tracks: [makeTrack()], currentTrackId: null }) });
  vi.mocked(session.sendAudioTrack).mockImplementation(() => pending);
  build({
    session,
    repository: fakeStore({}, { seed: [ID] }),
    gameId: 'game',
    createAudio: fakeAudio,
    createContext: fakeContext,
  });

  await vi.waitFor(async () => expect(await session.who(ID, 'peer-a')).toBe(true));
  const accepted = await Promise.race([
    session.fetch(ID, 'peer-b'),
    new Promise<'timeout'>(resolve => { setTimeout(() => resolve('timeout'), 250); }),
  ]);
  expect(accepted).toBe(true);
  expect(session.sendAudioTrack).toHaveBeenCalled();
  release();
  await pending;
});

it('keeps bytes in memory and warns when durable storage fails', async () => {
  const session = fakeSession({ view: view({ currentTrackId: null }) });
  const store = fakeStore({ putAudio: vi.fn(async () => ({ ok: false, message: 'storage denied' })) });
  const c = build({
    session,
    repository: store,
    gameId: 'game',
    createAudio: fakeAudio,
    createContext: fakeContext,
    probeDuration: async () => 6000,
    canPlay: () => true,
  });

  await c.actions.add(new File([new Uint8Array(4)], 'theme.wav', { type: 'audio/wav' }));

  expect(session.addTrack).toHaveBeenCalled();
  expect(session.sendAudioTrack).toHaveBeenCalled();
  expect(c.getView().status).toMatch(/persist|memory/i);
  const added = vi.mocked(session.addTrack).mock.calls[0][0];
  expect(await session.who(added.id, 'peer-a')).toBe(true);
});

it('removes stored bytes when publishing the track is rejected', async () => {
  const session = fakeSession({ view: view({ currentTrackId: null }) });
  vi.mocked(session.addTrack).mockReturnValue(false);
  const store = fakeStore();
  const c = build({
    session,
    repository: store,
    gameId: 'game',
    createAudio: fakeAudio,
    createContext: fakeContext,
    probeDuration: async () => 6000,
    canPlay: () => true,
  });

  await c.actions.add(new File([new Uint8Array(4)], 'rejected.wav', { type: 'audio/wav' }));

  const id = store.putAudio.mock.calls[0][1] as string;
  expect(store.removeAudio).toHaveBeenCalledWith('game', id);
  expect(await session.who(id, 'peer-a')).toBe(false);
  expect(session.sendAudioTrack).not.toHaveBeenCalled();
});

it('discards unsolicited bytes and progress for unknown track ids', async () => {
  const bytes = new Uint8Array([4, 5, 6]);
  const id = await sha256Hex(bytes);
  const store = fakeStore();
  const session = fakeSession({ view: view({ tracks: [], currentTrackId: null }) });
  const c = build({ session, repository: store, gameId: 'game', createAudio: fakeAudio, createContext: fakeContext });

  await session.receive(bytes, { trackId: id, name: 'orphan', type: 'audio/mpeg', size: 3 }, 'peer-a');
  expect(store.putAudio).not.toHaveBeenCalled();

  session.progress(0.7, { trackId: id, name: 'orphan', type: 'audio/mpeg', size: 3 }, 'peer-a');
  session.setAudio(view({ tracks: [makeTrack(id, 'orphan', 3)], currentTrackId: null }));
  session.emit();

  expect(c.getView().tracks[0]?.downloading).toBe(false);
  expect(c.getView().tracks[0]?.progress).toBe(0);
});

it('discards an incoming track that is already tombstoned', async () => {
  const bytes = new Uint8Array([7, 8, 9]);
  const id = await sha256Hex(bytes);
  const store = fakeStore();
  const session = fakeSession({ view: view({ tracks: [makeTrack(id)], tombstones: [id], currentTrackId: null }) });
  build({ session, repository: store, gameId: 'game', createAudio: fakeAudio, createContext: fakeContext });

  await session.receive(bytes, { trackId: id, name: 'x', type: 'audio/mpeg', size: 3 }, 'peer-a');

  expect(store.putAudio).not.toHaveBeenCalled();
});

it('discards bytes that finish storing after a tombstone arrives', async () => {
  const bytes = new Uint8Array([4, 4, 4, 4]);
  const id = await sha256Hex(bytes);
  let release: (result: { ok: true }) => void = () => {};
  const stored = new Promise<{ ok: true }>(resolve => { release = resolve; });
  const store = fakeStore({ putAudio: vi.fn(() => stored) });
  const session = fakeSession({ view: view({ tracks: [makeTrack(id, 'Theme.wav', 4)], currentTrackId: id, playing: true }) });
  const c = build({ session, repository: store, gameId: 'game', createAudio: fakeAudio, createContext: fakeContext });

  const receiving = session.receive(bytes, { trackId: id, name: 'Theme.wav', type: 'audio/wav', size: 4 }, 'peer-a');
  await vi.waitFor(() => expect(store.putAudio).toHaveBeenCalled());

  // The track is removed while the write is in flight.
  session.setAudio(view({ tracks: [], tombstones: [id], currentTrackId: null }));
  session.emit();
  release({ ok: true });
  await receiving;

  await vi.waitFor(() => expect(store.removeAudio).toHaveBeenCalledWith('game', id));
  expect(c.getView().tracks.some(track => track.id === id && track.available)).toBe(false);
  expect(c.getView().playing).toBe(false);
});

it('confirms before removing a track', () => {
  const session = fakeSession({ view: view({ tracks: [makeTrack()], currentTrackId: ID }) });
  const confirm = vi.fn(() => false);
  const c = build({
    session,
    repository: fakeStore(),
    gameId: 'game',
    confirm,
    createAudio: fakeAudio,
    createContext: fakeContext,
  });

  c.actions.remove(ID);
  expect(confirm).toHaveBeenCalled();
  expect(session.removeTrack).not.toHaveBeenCalled();

  confirm.mockReturnValue(true);
  c.actions.remove(ID);
  expect(session.removeTrack).toHaveBeenCalledWith(ID);
});

it('shows ended at the duration and restarts from zero', async () => {
  const audio = fakeAudio();
  audio.duration = 6;
  // The shared command still says playing, while the local element reached the end.
  // Pressing start must restart instead of issuing a stop at the duration.
  const session = fakeSession({ view: view({ playing: true, positionMs: 6000, currentTrackId: ID, startedAt: 0 }) });
  vi.mocked(session.playTrack).mockImplementation(() => {
    session.setAudio(view({ playing: true, positionMs: 0, currentTrackId: ID, startedAt: 1000 }));
    session.emit();
  });
  const c = build({
    session,
    repository: fakeStore({}, { seed: [ID] }),
    gameId: 'game',
    now: () => 1000,
    createAudio: () => audio,
    createContext: fakeContext,
  });

  await vi.waitFor(() => expect(audio.src).toBe('blob:audio'));
  await vi.waitFor(() => expect(c.getView().tracks[0]?.ended).toBe(true));
  expect(session.selectTrack).not.toHaveBeenCalled();

  c.actions.toggle();

  expect(session.playTrack).toHaveBeenCalled();
  expect(session.stopTrack).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(c.getView().tracks[0]?.ended).toBe(false));
  expect(c.getView().positionMs).toBe(0);
});

it('revokes the object URL and closes the context on destroy', async () => {
  const audio = fakeAudio();
  const context = fakeContext();
  const c = build({
    session: fakeSession({ view: view({ playing: false, currentTrackId: ID }) }),
    repository: fakeStore({}, { seed: [ID] }),
    gameId: 'game',
    createAudio: () => audio,
    createContext: () => context,
  });

  await vi.waitFor(() => expect(audio.src).toBe('blob:audio'));
  expect(context.createGain).toHaveBeenCalled();

  c.destroy();

  expect(revokeObjectURL).toHaveBeenCalledWith('blob:audio');
  expect(context.close).toHaveBeenCalled();
});

it('updates downloading progress from the incoming transfer listener', async () => {
  const session = fakeSession({ view: view({ tracks: [makeTrack()], currentTrackId: null }) });
  vi.mocked(session.requestAudioHolders).mockResolvedValue(['peer-b']);
  vi.mocked(session.requestAudioTrack).mockResolvedValue(true);
  const c = build({ session, repository: fakeStore(), gameId: 'game', createAudio: fakeAudio, createContext: fakeContext });

  await c.actions.retry(ID);
  session.progress(0.42, { trackId: ID, name: 'Theme.wav', type: 'audio/wav', size: 4 }, 'peer-b');

  const item = c.getView().tracks.find(track => track.id === ID);
  expect(item?.downloading).toBe(true);
  expect(item?.progress).toBeCloseTo(0.42);
});

it('mounts a hidden persistent audio element and removes it on destroy', () => {
  const c = build({
    session: fakeSession({ view: undefined }),
    repository: fakeStore(),
    gameId: 'game',
    createContext: fakeContext,
  });

  const element = document.querySelector<HTMLAudioElement>('#music-audio');
  expect(element).not.toBeNull();
  expect(element!.hidden).toBe(true);
  expect(element!.preload).toBe('auto');

  c.destroy();
  expect(document.querySelector('#music-audio')).toBeNull();
});

it('stays inert until a legacy session exposes audio', async () => {
  const session = fakeSession({ view: undefined });
  const c = build({ session, repository: fakeStore(), gameId: 'game', createAudio: fakeAudio, createContext: fakeContext });

  expect(c.getView().tracks).toEqual([]);
  expect(c.getView().connected).toBe(false);
  expect(session.onAudioTrack).not.toHaveBeenCalled();

  session.setAudio(view({ tracks: [makeTrack()], currentTrackId: null }));
  session.emit();
  await vi.waitFor(() => expect(c.getView().tracks).toHaveLength(1));
  expect(c.getView().connected).toBe(true);
  expect(session.onAudioTrack).toHaveBeenCalledOnce();
  expect(session.onAudioProgress).toHaveBeenCalledOnce();
});
