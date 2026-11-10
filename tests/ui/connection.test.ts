// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { mountApp } from '../../src/ui/app';
import { createWorkspaceRepository } from '../../src/storage/workspace-repository';
import { IDBFactory } from 'fake-indexeddb';
import { runtime } from '../helpers/game';
import { randomUUID } from 'node:crypto';
import { roomLink, createRoomLink, type RoomLink } from '../../src/network/room-link';
import { createWorkspace } from '../../src/game/workspace';
import { validateGame } from '../../src/game/validation';
import type { PeerSession, PeerSessionView } from '../../src/session/peer-types';
import type { WorkspaceSnapshot } from '../../src/game/sync-types';

beforeEach(() => { document.body.innerHTML = '<main id="root"></main>'; });
const root = () => document.querySelector<HTMLElement>('#root')!;

function fakeSession(initial: WorkspaceSnapshot | null, joinRoom = vi.fn()): PeerSession & { openRoom: ReturnType<typeof vi.fn> } {
  let room: RoomLink | null = null;
  const listeners = new Set<() => void>();
  const view = (): PeerSessionView => ({
    game: initial?.game ?? null,
    phase: 'ready',
    localPlayerId: initial?.game.players[0]?.id ?? null,
    onlinePlayerIds: initial?.game.players[0] ? [initial.game.players[0].id] : [],
    priorityParticipantId: null,
    canCreatePlayer: false,
    canRoll: true,
    canChat: false,
    messages: [],
    liveImages: [],
    hasRecovery: false,
    hasRoomLink: room !== null,
    unseatedParticipantCount: 0,
    conflicts: [],
    error: null,
    connectionError: null,
    saveGeneration: 0,
  });
  const openRoom = vi.fn(() => {
    room = createRoomLink(initial?.game.id ?? 'game');
    for (const fn of listeners) fn();
    return room;
  });
  return {
    getView: view,
    getSnapshot: () => initial,
    getRecoverySnapshot: () => null,
    getRoomLink: () => room,
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    openRoom,
    joinRoom,
    selectPlayer: () => {},
    createPlayer: () => {},
    sendMessage: () => false,
    roll: () => {},
    edit: () => {},
    addTrack: () => false,
    removeTrack: () => {},
    setTrackGain: () => false,
    selectTrack: () => {},
    playTrack: () => {},
    stopTrack: () => {},
    seekTrack: () => {},
    sendAudioTrack: async () => {},
    requestAudioHolders: async () => [],
    requestAudioTrack: async () => false,
    requestAudioPosition: async () => null,
    onAudioTrack: () => () => {},
    onAudioFetch: () => () => {},
    onAudioWho: () => () => {},
    onAudioPosition: () => () => {},
    disconnect: () => {},
    close: () => { listeners.clear(); },
  };
}

it('joins a room link directly without showing the start screen', async () => {
  const link = roomLink(createRoomLink('game'), location.href);
  history.replaceState(null, '', link);
  const joinRoom = vi.fn();
  const session = fakeSession(null, joinRoom);
  const app = mountApp(root(), {
    repository: createWorkspaceRepository({ indexedDB: new IDBFactory(), dbName: randomUUID(), runtime: runtime() }),
    runtime: runtime(),
    environment: { canCreate: true, canConnect: true, message: '' },
    createSession: (() => session) as any,
  });
  await vi.waitFor(() => expect(joinRoom).toHaveBeenCalledOnce());
  expect(joinRoom.mock.calls[0][0].gameId).toBe('game');
  expect(location.hash).toBe('');
  expect(document.querySelector('#new-game')).toBeNull();
  expect(document.querySelector('#join-code')).toBeNull();
  app.destroy();
});

it('passes the saved local copy for the same game into the joined session', async () => {
  const repo = createWorkspaceRepository({ indexedDB: new IDBFactory(), dbName: randomUUID(), runtime: runtime() });
  const game = validateGame({ schemaVersion: 1, id: 'game', name: 'Local Fork', createdAt: '2026-10-27T12:00:00.000Z', updatedAt: '2026-10-27T12:00:00.000Z', revision: 0, players: [{ id: 'alex', name: 'Alex', role: 'gm' }], rolls: [] });
  const workspace = createWorkspace(game, runtime());
  const snapshot = workspace.getSnapshot();
  workspace.destroy();
  await repo.save(snapshot, 0);
  const link = roomLink(createRoomLink('game'), location.href);
  history.replaceState(null, '', link);
  const createSession = vi.fn((options: { initial: WorkspaceSnapshot | null; rememberedPlayerId: string | null }) => fakeSession(options.initial));
  const app = mountApp(root(), {
    repository: repo,
    runtime: runtime(),
    environment: { canCreate: true, canConnect: true, message: '' },
    createSession: createSession as any,
  });
  await vi.waitFor(() => expect(createSession).toHaveBeenCalled());
  const options = createSession.mock.calls[0][0];
  expect(options.initial!.game.name).toBe('Local Fork');
  expect(options.rememberedPlayerId).toBeNull();
  app.destroy();
});

it('returns to the start screen with an error when the room link is invalid', async () => {
  history.replaceState(null, '', '#room=not-a-link');
  const app = mountApp(root(), {
    repository: createWorkspaceRepository({ indexedDB: new IDBFactory(), dbName: randomUUID(), runtime: runtime() }),
    runtime: runtime(),
    environment: { canCreate: true, canConnect: true, message: '' },
  });
  await vi.waitFor(() => expect(root().querySelector('#new-game')).not.toBeNull());
  expect(root().textContent).toContain('Invalid room link');
  app.destroy();
});

it('opens, copies and shows the room link from one Connect click', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const app = mountApp(root(), {
    repository: createWorkspaceRepository({ indexedDB: new IDBFactory(), dbName: randomUUID(), runtime: runtime() }),
    runtime: runtime(),
    environment: { canCreate: true, canConnect: true, message: '' },
    createSession: ((options: { initial: WorkspaceSnapshot | null }) => fakeSession(options.initial)) as any,
  });
  await vi.waitFor(() => expect(root().querySelector('#new-game')).not.toBeNull());
  (document.querySelector<HTMLInputElement>('#game-name')!).value = 'Lantern';
  (document.querySelector<HTMLInputElement>('#creator-name')!).value = 'Alex';
  document.querySelector<HTMLFormElement>('#new-game')!.requestSubmit();
  await vi.waitFor(() => expect(root().querySelector('#open-room')).not.toBeNull());
  document.querySelector<HTMLButtonElement>('#open-room')!.click();
  await vi.waitFor(() => expect(document.querySelector<HTMLTextAreaElement>('#room-link-output')?.value).toMatch(/#room=/));
  await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
  expect(writeText.mock.calls[0][0]).toContain('#room=');
  await vi.waitFor(() => expect(document.body.textContent).toContain('Link copied'));
  expect(document.querySelector<HTMLButtonElement>('#open-room')!.textContent).toBe('Share link');
  app.destroy();
});
