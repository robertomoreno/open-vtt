// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createTableView } from '../../src/ui/table';
import { fixtureGame } from '../helpers/game';
import type { PeerSessionView } from '../../src/session/peer-types';

function makeView(overrides: Partial<PeerSessionView> = {}): PeerSessionView {
  const game = fixtureGame();
  return {
    game,
    phase: 'ready',
    localPlayerId: 'alex',
    onlinePlayerIds: ['alex'],
    priorityParticipantId: 'p1',
    canCreatePlayer: false,
    canRoll: true,
    canChat: true,
    messages: [],
    liveImages: [],
    hasRecovery: false,
    hasRoomLink: false,
    unseatedParticipantCount: 0,
    conflicts: [],
    error: null,
    connectionError: null,
    saveGeneration: 1,
    ...overrides,
  };
}

it('preserves focus on roll during updates', () => {
  document.body.innerHTML = '<main></main>';
  const view = makeView();
  const actions = { roll: () => {}, download: () => {}, downloadRecovery: () => {}, share: () => {}, disconnect: () => {}, leave: () => {}, choosePlayer: () => {}, createPlayer: () => {} };
  const t = createTableView(document.querySelector('main')!, view, actions);
  const roll = document.querySelector<HTMLButtonElement>('#roll')!;
  roll.focus();
  t.update({ ...view, phase: 'offline', canRoll: true });
  expect(document.activeElement).toBe(roll);
  t.destroy();
});

it('enables Roll when offline canRoll is true', () => {
  document.body.innerHTML = '<main></main>';
  const view = makeView({ phase: 'offline', canRoll: true });
  const actions = { roll: () => {}, download: () => {}, downloadRecovery: () => {}, share: () => {}, disconnect: () => {}, leave: () => {}, choosePlayer: () => {}, createPlayer: () => {} };
  const t = createTableView(document.querySelector('main')!, view, actions);
  expect(document.querySelector<HTMLButtonElement>('#roll')!.disabled).toBe(false);
  t.destroy();
});

it('surfaces a transport connection error instead of the waiting text', () => {
  document.body.innerHTML = '<main></main>';
  const view = makeView({ phase: 'waiting', connectionError: 'Room discovery failed.' });
  const actions = { roll: () => {}, download: () => {}, downloadRecovery: () => {}, share: () => {}, disconnect: () => {}, leave: () => {}, choosePlayer: () => {}, createPlayer: () => {} };
  const t = createTableView(document.querySelector('main')!, view, actions);
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Room discovery failed.');
  t.destroy();
});

it('shows recovery action when hasRecovery is true', () => {
  document.body.innerHTML = '<main></main>';
  const view = makeView({ hasRecovery: true });
  const actions = { roll: () => {}, download: () => {}, downloadRecovery: () => {}, share: () => {}, disconnect: () => {}, leave: () => {}, choosePlayer: () => {}, createPlayer: () => {} };
  const t = createTableView(document.querySelector('main')!, view, actions);
  expect(document.querySelector('#download-recovery')).not.toBeNull();
  t.destroy();
});

it('renders escaped conflict values without img', () => {
  document.body.innerHTML = '<main></main>';
  const view = makeView({ conflicts: [{ id: 'c1', affected: ['game.name'], reason: 'concurrent-value', candidates: [{ operationId: 'o1', value: '<img onerror=alert(1)>' }], retained: 'Old', explanation: '<img onerror=alert(1)>' }] });
  const actions = { roll: () => {}, download: () => {}, downloadRecovery: () => {}, share: () => {}, disconnect: () => {}, leave: () => {}, choosePlayer: () => {}, createPlayer: () => {} };
  const t = createTableView(document.querySelector('main')!, view, actions);
  expect(document.querySelector('img')).toBeNull();
  t.destroy();
});

it('renders no Approve/Reject/reply-code controls', () => {
  document.body.innerHTML = '<main></main>';
  const view = makeView();
  const actions = { roll: () => {}, download: () => {}, downloadRecovery: () => {}, share: () => {}, disconnect: () => {}, leave: () => {}, choosePlayer: () => {}, createPlayer: () => {} };
  const t = createTableView(document.querySelector('main')!, view, actions);
  expect(document.body.textContent).not.toMatch(/Approve|Reject|reply-code/i);
  t.destroy();
});

it('preserves die selection across updates', () => {
  document.body.innerHTML = '<main></main>';
  const view = makeView();
  const actions = { roll: () => {}, download: () => {}, downloadRecovery: () => {}, share: () => {}, disconnect: () => {}, leave: () => {}, choosePlayer: () => {}, createPlayer: () => {} };
  const t = createTableView(document.querySelector('main')!, view, actions);
  const die = document.querySelector<HTMLSelectElement>('#die')!;
  die.value = '6';
  die.focus();
  t.update({ ...view, phase: 'offline', canRoll: false });
  expect(die.value).toBe('6');
  expect(document.activeElement).toBe(die);
  t.destroy();
});

it('shows the room action as Connect before a link exists and Share link after', () => {
  document.body.innerHTML = '<main></main>';
  const actions = { roll: () => {}, download: () => {}, downloadRecovery: () => {}, share: () => {}, disconnect: () => {}, leave: () => {}, choosePlayer: () => {}, createPlayer: () => {} };
  const view = makeView({ hasRoomLink: false, phase: 'local' });
  const t = createTableView(document.querySelector('main')!, view, actions);
  const room = document.querySelector<HTMLButtonElement>('#open-room')!;
  expect(room.textContent).toBe('Connect');
  expect(room.hidden).toBe(false);
  t.update({ ...view, hasRoomLink: true, phase: 'ready' });
  expect(room.textContent).toBe('Share link');
  expect(room.hidden).toBe(false);
  t.destroy();
});

it('shows a GM the add-player form and the waiting-player prompt', () => {
  document.body.innerHTML = '<main></main>';
  const actions = { roll: () => {}, download: () => {}, downloadRecovery: () => {}, share: () => {}, disconnect: () => {}, leave: () => {}, choosePlayer: () => {}, createPlayer: () => {} };
  const view = makeView({ canCreatePlayer: true, onlinePlayerIds: ['alex'], unseatedParticipantCount: 2 });
  const t = createTableView(document.querySelector('main')!, view, actions);
  expect(document.querySelector<HTMLFormElement>('#add-player-form')!.hidden).toBe(false);
  expect(document.body.textContent).toContain('2 participants waiting for a character');
  t.destroy();
});

it('hides the add-player form from a non-GM', () => {
  document.body.innerHTML = '<main></main>';
  const actions = { roll: () => {}, download: () => {}, downloadRecovery: () => {}, share: () => {}, disconnect: () => {}, leave: () => {}, choosePlayer: () => {}, createPlayer: () => {} };
  const game = { ...fixtureGame(), players: [
    { id: 'alex', name: 'Alex', role: 'gm' as const },
    { id: 'bea', name: 'Bea', role: 'pj' as const },
  ] };
  const view = makeView({ game, localPlayerId: 'bea', onlinePlayerIds: ['alex', 'bea'] });
  const t = createTableView(document.querySelector('main')!, view, actions);
  expect(document.querySelector<HTMLFormElement>('#add-player-form')!.hidden).toBe(true);
  t.destroy();
});

it('submits a new player from the GM table form', () => {
  document.body.innerHTML = '<main></main>';
  const createPlayer = vi.fn();
  const actions = { roll: () => {}, download: () => {}, downloadRecovery: () => {}, share: () => {}, disconnect: () => {}, leave: () => {}, choosePlayer: () => {}, createPlayer };
  const view = makeView({ canCreatePlayer: true });
  const t = createTableView(document.querySelector('main')!, view, actions);
  (document.querySelector<HTMLInputElement>('#new-player-name')!).value = 'Bea';
  (document.querySelector<HTMLSelectElement>('#new-player-role')!).value = 'pj';
  document.querySelector<HTMLFormElement>('#add-player-form')!.requestSubmit();
  expect(createPlayer).toHaveBeenCalledWith('Bea', 'pj');
  t.destroy();
});
