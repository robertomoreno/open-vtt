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
    hasRecovery: false,
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
  const actions = { roll: () => {}, download: () => {}, downloadRecovery: () => {}, connect: () => {}, disconnect: () => {}, leave: () => {}, choosePlayer: () => {} };
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
  const actions = { roll: () => {}, download: () => {}, downloadRecovery: () => {}, connect: () => {}, disconnect: () => {}, leave: () => {}, choosePlayer: () => {} };
  const t = createTableView(document.querySelector('main')!, view, actions);
  expect(document.querySelector<HTMLButtonElement>('#roll')!.disabled).toBe(false);
  t.destroy();
});

it('surfaces a transport connection error instead of the waiting text', () => {
  document.body.innerHTML = '<main></main>';
  const view = makeView({ phase: 'waiting', connectionError: 'Room discovery failed.' });
  const actions = { roll: () => {}, download: () => {}, downloadRecovery: () => {}, connect: () => {}, disconnect: () => {}, leave: () => {}, choosePlayer: () => {} };
  const t = createTableView(document.querySelector('main')!, view, actions);
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Room discovery failed.');
  t.destroy();
});

it('shows recovery action when hasRecovery is true', () => {
  document.body.innerHTML = '<main></main>';
  const view = makeView({ hasRecovery: true });
  const actions = { roll: () => {}, download: () => {}, downloadRecovery: () => {}, connect: () => {}, disconnect: () => {}, leave: () => {}, choosePlayer: () => {} };
  const t = createTableView(document.querySelector('main')!, view, actions);
  expect(document.querySelector('#download-recovery')).not.toBeNull();
  t.destroy();
});

it('renders escaped conflict values without img', () => {
  document.body.innerHTML = '<main></main>';
  const view = makeView({ conflicts: [{ id: 'c1', affected: ['game.name'], reason: 'concurrent-value', candidates: [{ operationId: 'o1', value: '<img onerror=alert(1)>' }], retained: 'Old', explanation: '<img onerror=alert(1)>' }] });
  const actions = { roll: () => {}, download: () => {}, downloadRecovery: () => {}, connect: () => {}, disconnect: () => {}, leave: () => {}, choosePlayer: () => {} };
  const t = createTableView(document.querySelector('main')!, view, actions);
  expect(document.querySelector('img')).toBeNull();
  t.destroy();
});

it('renders no Approve/Reject/reply-code controls', () => {
  document.body.innerHTML = '<main></main>';
  const view = makeView();
  const actions = { roll: () => {}, download: () => {}, downloadRecovery: () => {}, connect: () => {}, disconnect: () => {}, leave: () => {}, choosePlayer: () => {} };
  const t = createTableView(document.querySelector('main')!, view, actions);
  expect(document.body.textContent).not.toMatch(/Approve|Reject|reply-code/i);
  t.destroy();
});

it('preserves die selection across updates', () => {
  document.body.innerHTML = '<main></main>';
  const view = makeView();
  const actions = { roll: () => {}, download: () => {}, downloadRecovery: () => {}, connect: () => {}, disconnect: () => {}, leave: () => {}, choosePlayer: () => {} };
  const t = createTableView(document.querySelector('main')!, view, actions);
  const die = document.querySelector<HTMLSelectElement>('#die')!;
  die.value = '6';
  die.focus();
  t.update({ ...view, phase: 'offline', canRoll: false });
  expect(die.value).toBe('6');
  expect(document.activeElement).toBe(die);
  t.destroy();
});
