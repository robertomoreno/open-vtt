// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { createTableView, type TableActions } from '../../src/ui/table';
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

function actions(overrides: Partial<TableActions> = {}): TableActions {
  return {
    roll: () => {}, download: () => {}, downloadRecovery: () => {}, share: () => {},
    disconnect: () => {}, leave: () => {}, choosePlayer: () => {}, createPlayer: () => {},
    sendMessage: () => true,
    prepareImage: async () => ({ dataUrl: 'data:image/png;base64,AAAA', name: 'pixel.png', type: 'image/png' as const, width: 1, height: 1 }),
    ...overrides,
  };
}

function chatGame() {
  return { ...fixtureGame(), players: [
    { id: 'alex', name: 'Alex', role: 'gm' as const },
    { id: 'bea', name: 'Bea', role: 'pj' as const },
    { id: 'cy', name: 'Cy', role: 'pj' as const },
  ] };
}

const main = () => document.querySelector('main')!;

beforeEach(() => { document.body.innerHTML = '<main></main>'; });

it('preserves focus on roll during updates', () => {
  const view = makeView();
  const t = createTableView(main(), view, actions());
  const roll = document.querySelector<HTMLButtonElement>('#roll')!;
  roll.focus();
  t.update({ ...view, phase: 'offline', canRoll: true });
  expect(document.activeElement).toBe(roll);
  t.destroy();
});

it('enables Roll when offline canRoll is true', () => {
  const view = makeView({ phase: 'offline', canRoll: true });
  const t = createTableView(main(), view, actions());
  expect(document.querySelector<HTMLButtonElement>('#roll')!.disabled).toBe(false);
  t.destroy();
});

it('surfaces a transport connection error instead of the waiting text', () => {
  const view = makeView({ phase: 'waiting', connectionError: 'Room discovery failed.' });
  const t = createTableView(main(), view, actions());
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Room discovery failed.');
  t.destroy();
});

it('shows recovery action when hasRecovery is true', () => {
  const view = makeView({ hasRecovery: true });
  const t = createTableView(main(), view, actions());
  expect(document.querySelector('#download-recovery')).not.toBeNull();
  t.destroy();
});

it('renders escaped conflict values without img', () => {
  const view = makeView({ conflicts: [{ id: 'c1', affected: ['game.name'], reason: 'concurrent-value', candidates: [{ operationId: 'o1', value: '<img onerror=alert(1)>' }], retained: 'Old', explanation: '<img onerror=alert(1)>' }] });
  const t = createTableView(main(), view, actions());
  expect(document.querySelector('img')).toBeNull();
  t.destroy();
});

it('renders no Approve/Reject/reply-code controls', () => {
  const view = makeView();
  const t = createTableView(main(), view, actions());
  expect(document.body.textContent).not.toMatch(/Approve|Reject|reply-code/i);
  t.destroy();
});

it('preserves die selection across updates', () => {
  const view = makeView();
  const t = createTableView(main(), view, actions());
  const die = document.querySelector<HTMLSelectElement>('#die')!;
  die.value = '6';
  die.focus();
  t.update({ ...view, phase: 'offline', canRoll: false });
  expect(die.value).toBe('6');
  expect(document.activeElement).toBe(die);
  t.destroy();
});

it('shows the room action as Connect before a link exists and Share link after', () => {
  const view = makeView({ hasRoomLink: false, phase: 'local' });
  const t = createTableView(main(), view, actions());
  const room = document.querySelector<HTMLButtonElement>('#open-room')!;
  expect(room.textContent).toBe('Connect');
  expect(room.hidden).toBe(false);
  t.update({ ...view, hasRoomLink: true, phase: 'ready' });
  expect(room.textContent).toBe('Share link');
  expect(room.hidden).toBe(false);
  t.destroy();
});

it('shows a GM the add-player form and the waiting-player prompt', () => {
  const view = makeView({ canCreatePlayer: true, onlinePlayerIds: ['alex'], unseatedParticipantCount: 2 });
  const t = createTableView(main(), view, actions());
  expect(document.querySelector<HTMLFormElement>('#add-player-form')!.hidden).toBe(false);
  expect(document.body.textContent).toContain('2 participants waiting for a character');
  t.destroy();
});

it('hides the add-player form from a non-GM', () => {
  const game = { ...fixtureGame(), players: [
    { id: 'alex', name: 'Alex', role: 'gm' as const },
    { id: 'bea', name: 'Bea', role: 'pj' as const },
  ] };
  const view = makeView({ game, localPlayerId: 'bea', onlinePlayerIds: ['alex', 'bea'] });
  const t = createTableView(main(), view, actions());
  expect(document.querySelector<HTMLFormElement>('#add-player-form')!.hidden).toBe(true);
  t.destroy();
});

it('submits a new player from the GM table form', () => {
  const createPlayer = vi.fn();
  const view = makeView({ canCreatePlayer: true });
  const t = createTableView(main(), view, actions({ createPlayer }));
  (document.querySelector<HTMLInputElement>('#new-player-name')!).value = 'Bea';
  (document.querySelector<HTMLSelectElement>('#new-player-role')!).value = 'pj';
  document.querySelector<HTMLFormElement>('#add-player-form')!.requestSubmit();
  expect(createPlayer).toHaveBeenCalledWith('Bea', 'pj');
  t.destroy();
});

it('renders rolls and messages in chronological order', () => {
  const view = makeView({ messages: [
    { id: 'm1', playerId: 'alex', at: '2026-01-01T00:00:01.000Z', text: 'Hello', recipients: null },
  ], game: { ...fixtureGame(), rolls: [{ id: 'r1', playerId: 'alex', sides: 20, value: 7, at: '2026-01-01T00:00:02.000Z' }] } });
  const t = createTableView(main(), view, actions());
  const ids = [...document.querySelectorAll('[data-roll], [data-chat]')].map(n => n.getAttribute('data-roll') ?? n.getAttribute('data-chat'));
  expect(ids).toEqual(['m1', 'r1']);
  t.destroy();
});

it('hides private messages outside the audience and labels them for recipients', () => {
  const privateMessage = { id: 'm1', playerId: 'alex', at: '2026-01-01T00:00:00.000Z', text: 'For Bea', recipients: ['alex', 'bea'] };
  const observer = createTableView(main(), makeView({ game: chatGame(), messages: [privateMessage], localPlayerId: 'cy' }), actions());
  expect(document.querySelector('[data-chat="m1"]')).toBeNull();
  observer.destroy();
  const recipient = createTableView(main(), makeView({ game: chatGame(), messages: [privateMessage], localPlayerId: 'bea' }), actions());
  expect(document.querySelector('[data-chat="m1"]')!.textContent).toContain('Private · Alex, Bea');
  recipient.destroy();
});

it('sends a public message and clears the draft', () => {
  const sent: any[] = [];
  const t = createTableView(main(), makeView(), actions({ sendMessage: draft => { sent.push(draft); return true; } }));
  const input = document.querySelector<HTMLTextAreaElement>('#chat-message')!;
  input.value = 'Hello';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector<HTMLButtonElement>('#chat-send')!.click();
  expect(sent).toEqual([{ text: 'Hello', recipients: null, image: undefined }]);
  expect(input.value).toBe('');
  t.destroy();
});

it('sends a private message with selected players and resets to public', () => {
  const sent: any[] = [];
  const t = createTableView(main(), makeView({ game: chatGame() }), actions({ sendMessage: draft => { sent.push(draft); return true; } }));
  const privateToggle = document.querySelector<HTMLInputElement>('#chat-private')!;
  privateToggle.checked = true;
  privateToggle.dispatchEvent(new Event('change', { bubbles: true }));
  const bea = document.querySelector<HTMLInputElement>('#chat-recipient-bea')!;
  bea.checked = true;
  bea.dispatchEvent(new Event('change', { bubbles: true }));
  const input = document.querySelector<HTMLTextAreaElement>('#chat-message')!;
  input.value = 'Secret';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector<HTMLButtonElement>('#chat-send')!.click();
  expect(sent[0].recipients).toEqual(['bea']);
  expect(privateToggle.checked).toBe(false);
  t.destroy();
});

it('keeps the draft when the session rejects a send', () => {
  const t = createTableView(main(), makeView(), actions({ sendMessage: () => false }));
  const input = document.querySelector<HTMLTextAreaElement>('#chat-message')!;
  input.value = 'Keep this';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector<HTMLButtonElement>('#chat-send')!.click();
  expect(input.value).toBe('Keep this');
  t.destroy();
});

it('preserves the draft and focus across session updates', () => {
  const view = makeView();
  const t = createTableView(main(), view, actions());
  const input = document.querySelector<HTMLTextAreaElement>('#chat-message')!;
  input.value = 'Half-written';
  input.focus();
  t.update({ ...view, phase: 'offline', canChat: true });
  expect(input.value).toBe('Half-written');
  expect(document.activeElement).toBe(input);
  t.destroy();
});

it('disables the composer without a seated player', () => {
  const t = createTableView(main(), makeView({ canChat: false, localPlayerId: null }), actions());
  expect(document.querySelector<HTMLTextAreaElement>('#chat-message')!.disabled).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('#chat-send')!.disabled).toBe(true);
  t.destroy();
});

it('previews and removes an attached image without sending it yet', async () => {
  const prepare = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,AAAA', name: 'map.png', type: 'image/png' as const, width: 10, height: 10 }));
  const t = createTableView(main(), makeView(), actions({ prepareImage: prepare }));
  const fileInput = document.querySelector<HTMLInputElement>('#chat-image-input')!;
  Object.defineProperty(fileInput, 'files', { value: [new File(['x'], 'map.png', { type: 'image/png' })] });
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(document.querySelector('.chat-preview img')).not.toBeNull());
  expect(document.querySelector('.chat-preview')!.textContent).toContain('map.png');
  expect(document.querySelector('.chat-preview')!.textContent).toContain('10 × 10 px');
  document.querySelector<HTMLButtonElement>('[aria-label="Remove image"]')!.click();
  expect(document.querySelector('.chat-preview')!.hasAttribute('hidden')).toBe(true);
  t.destroy();
});

it('attaches a dropped image through the same preview path', async () => {
  const prepare = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,AAAA', name: 'drop.png', type: 'image/png' as const, width: 4, height: 4 }));
  const t = createTableView(main(), makeView(), actions({ prepareImage: prepare }));
  const drop = new Event('drop', { bubbles: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File(['x'], 'drop.png', { type: 'image/png' })] } });
  document.querySelector<HTMLFormElement>('#chat-form')!.dispatchEvent(drop);
  await vi.waitFor(() => expect(document.querySelector('.chat-preview img')).not.toBeNull());
  expect(prepare).toHaveBeenCalledTimes(1);
  t.destroy();
});

it('keeps the draft and shows an error when image preparation fails', async () => {
  const t = createTableView(main(), makeView(), actions({ prepareImage: async () => { throw new Error('That image is too large.'); } }));
  const input = document.querySelector<HTMLTextAreaElement>('#chat-message')!;
  input.value = 'Keep me';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const fileInput = document.querySelector<HTMLInputElement>('#chat-image-input')!;
  Object.defineProperty(fileInput, 'files', { value: [new File(['x'], 'x.png', { type: 'image/png' })] });
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(document.querySelector('#chat-status')!.textContent).toMatch(/too large/i));
  expect(input.value).toBe('Keep me');
  t.destroy();
});

it('merges a message and its image into one ledger entry', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const view = makeView({
    messages: [{ id: 'm1', playerId: 'alex', at, text: 'Look', recipients: null }],
    liveImages: [{ id: 'm1', playerId: 'alex', at, recipients: null, name: 'map.png', type: 'image/png', width: 2, height: 2, dataUrl: 'data:image/png;base64,AAAA' }],
  });
  const t = createTableView(main(), view, actions());
  expect(document.querySelectorAll('[data-chat="m1"]')).toHaveLength(1);
  expect(document.querySelector('[data-chat="m1"]')!.textContent).toContain('Look');
  expect(document.querySelector('[data-chat="m1"] img')!.getAttribute('alt')).toBe('Image from Alex');
  t.destroy();
});

it('shows at most the newest 100 chat entries', () => {
  const messages = Array.from({ length: 101 }, (_, i) => ({
    id: `m${String(i).padStart(3, '0')}`,
    playerId: 'alex',
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    text: `t${i}`,
    recipients: null,
  }));
  const t = createTableView(main(), makeView({ messages }), actions());
  const ids = [...document.querySelectorAll('[data-chat]')].map(n => n.getAttribute('data-chat'));
  expect(ids).toHaveLength(100);
  expect(ids[0]).toBe('m001');
  expect(ids[99]).toBe('m100');
  t.destroy();
});

it('does not rebuild the ledger when the content is unchanged', () => {
  const message = { id: 'm1', playerId: 'alex', at: '2026-01-01T00:00:00.000Z', text: 'Hello', recipients: null };
  const view = makeView({ messages: [message] });
  const t = createTableView(main(), view, actions());
  const entry = document.querySelector('[data-chat="m1"]');
  t.update({ ...view, messages: [{ ...message }] });
  expect(document.querySelector('[data-chat="m1"]')).toBe(entry);
  t.update({ ...view, messages: [{ ...message, text: 'Hello again' }] });
  expect(document.querySelector('[data-chat="m1"]')).not.toBe(entry);
  expect(document.querySelector('[data-chat="m1"]')!.textContent).toContain('Hello again');
  t.destroy();
});

it('refreshes ledger author names when the roster changes', () => {
  const message = { id: 'm1', playerId: 'alex', at: '2026-01-01T00:00:00.000Z', text: 'Hello', recipients: null };
  const view = makeView({ game: chatGame(), messages: [message] });
  const t = createTableView(main(), view, actions());
  expect(document.querySelector('[data-chat="m1"]')!.textContent).toContain('Alex');
  const renamed = { ...chatGame(), players: chatGame().players.map(p => p.id === 'alex' ? { ...p, name: 'Alexandra' } : p) };
  t.update({ ...view, game: renamed });
  expect(document.querySelector('[data-chat="m1"]')!.textContent).toContain('Alexandra');
  t.destroy();
});

it('sends on Enter but keeps Shift+Enter for a newline', () => {
  const sent: any[] = [];
  const t = createTableView(main(), makeView(), actions({ sendMessage: draft => { sent.push(draft); return true; } }));
  const input = document.querySelector<HTMLTextAreaElement>('#chat-message')!;
  input.value = 'Hi';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
  expect(sent).toHaveLength(0);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(sent).toEqual([{ text: 'Hi', recipients: null, image: undefined }]);
  t.destroy();
});

it('reveals the recipient list with the local player fixed when private', () => {
  const t = createTableView(main(), makeView({ game: chatGame() }), actions());
  const toggle = document.querySelector<HTMLInputElement>('#chat-private')!;
  const fieldset = document.querySelector<HTMLFieldSetElement>('.chat-recipients')!;
  expect(fieldset.hidden).toBe(true);
  toggle.checked = true;
  toggle.dispatchEvent(new Event('change', { bubbles: true }));
  expect(fieldset.hidden).toBe(false);
  const alex = document.querySelector<HTMLInputElement>('#chat-recipient-alex')!;
  expect(alex.checked).toBe(true);
  expect(alex.disabled).toBe(true);
  t.destroy();
});
