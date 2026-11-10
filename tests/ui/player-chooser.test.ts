// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { randomUUID } from 'node:crypto';
import type { PeerSession, PeerSessionView } from '../../src/session/peer-types';
import type { Game, Role } from '../../src/game/types';
import { validateGame } from '../../src/game/validation';
import { createWorkspaceRepository } from '../../src/storage/workspace-repository';
import { mountApp } from '../../src/ui/app';
import { runtime } from '../helpers/game';

const AT = '2026-10-27T12:00:00.000Z';

beforeEach(() => { document.body.innerHTML = '<main id="root"></main>'; localStorage.clear(); });
const root = () => document.querySelector<HTMLElement>('#root')!;

function chooserGame(): Game {
  return validateGame({
    schemaVersion: 1, id: 'game', name: 'Chooser Table', createdAt: AT, updatedAt: AT, revision: 0,
    players: [{ id: 'alex', name: 'Alex', role: 'gm' }, { id: 'bea', name: 'Bea', role: 'pj' }],
    rolls: [],
  });
}

/** Minimal session view; the chooser transition is owned by the app, not the session. */
function fakeSession(game: Game): PeerSession {
  let localPlayerId: string | null = 'alex';
  const listeners = new Set<() => void>();
  const view = (): PeerSessionView => ({
    game,
    phase: 'ready',
    localPlayerId,
    onlinePlayerIds: [],
    priorityParticipantId: null,
    canCreatePlayer: false,
    canRoll: localPlayerId !== null,
    canChat: false,
    messages: [],
    liveImages: [],
    hasRecovery: false,
    hasRoomLink: false,
    unseatedParticipantCount: 0,
    conflicts: [],
    error: null,
    connectionError: null,
    saveGeneration: 0,
  });
  return {
    getView: view,
    getSnapshot: () => null,
    getRecoverySnapshot: () => null,
    getRoomLink: () => null,
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    openRoom: () => null,
    joinRoom: () => {},
    selectPlayer(id: string) { localPlayerId = id; for (const fn of [...listeners]) fn(); },
    createPlayer: (_name: string, _role: Role) => {},
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

it('returns to the shared table after selecting a player from the manual chooser', async () => {
  const session = fakeSession(chooserGame());
  const repo = createWorkspaceRepository({ indexedDB: new IDBFactory(), dbName: randomUUID(), runtime: runtime() });
  const app = mountApp(root(), { repository: repo, runtime: runtime(), createSession: () => session });

  await vi.waitFor(() => expect(root().querySelector('#new-game')).not.toBeNull());
  root().querySelector<HTMLInputElement>('#game-name')!.value = 'Chooser Table';
  root().querySelector<HTMLInputElement>('#creator-name')!.value = 'Alex';
  root().querySelector<HTMLFormElement>('#new-game')!.requestSubmit();

  await vi.waitFor(() => expect(root().querySelector('#choose-player')).not.toBeNull());
  root().querySelector<HTMLButtonElement>('#choose-player')!.click();
  await vi.waitFor(() => expect(root().querySelector('#player-name')).not.toBeNull());

  // Switching identity must return to the table, where the shared roll history lives.
  const first = root().querySelector<HTMLSelectElement>('#player-existing')!;
  first.value = 'bea';
  root().querySelector<HTMLButtonElement>('#join-selected-player')!.click();
  await vi.waitFor(() => expect(root().querySelector('#roll')).not.toBeNull());
  expect(root().querySelector('#player-name')).toBeNull();

  // Re-selecting the already local identity also closes the chooser.
  root().querySelector<HTMLButtonElement>('#choose-player')!.click();
  await vi.waitFor(() => expect(root().querySelector('#player-name')).not.toBeNull());
  const second = root().querySelector<HTMLSelectElement>('#player-existing')!;
  second.value = 'bea';
  root().querySelector<HTMLButtonElement>('#join-selected-player')!.click();
  await vi.waitFor(() => expect(root().querySelector('#roll')).not.toBeNull());
  expect(root().querySelector('#player-name')).toBeNull();

  app.destroy();
});
