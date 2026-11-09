// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createPlayerView } from '../../src/ui/player';
import { fixtureGame } from '../helpers/game';

it('does not submit offline creation', () => {
  document.body.innerHTML = '<main></main>';
  const game = fixtureGame();
  const create = vi.fn();
  const view = createPlayerView(document.querySelector('main')!, { game, selectedId: null, occupiedIds: [], canCreate: false, message: null }, { select: () => {}, create, cancel: () => {} });
  const form = document.querySelector<HTMLFormElement>('#create-player-form')!;
  expect(form.hidden).toBe(true);
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  expect(create).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLButtonElement>('#create-player')!.disabled).toBe(true);
  view.destroy();
});

it('hides player creation from a seated non-GM and explains the wait', () => {
  document.body.innerHTML = '<main></main>';
  const game = { ...fixtureGame(), players: [
    { id: 'alex', name: 'Alex', role: 'gm' as const },
    { id: 'bea', name: 'Bea', role: 'pj' as const },
  ] };
  const view = createPlayerView(document.querySelector('main')!, { game, selectedId: 'bea', occupiedIds: ['alex', 'bea'], canCreate: false, message: null }, { select: () => {}, create: () => {}, cancel: () => {} });
  expect(document.querySelector<HTMLFormElement>('#create-player-form')!.hidden).toBe(true);
  expect(document.body.textContent).toContain('Waiting for the GM');
  view.destroy();
});

it('shows the create form to a seated GM and submits it', () => {
  document.body.innerHTML = '<main></main>';
  const game = fixtureGame();
  const create = vi.fn();
  const view = createPlayerView(document.querySelector('main')!, { game, selectedId: 'alex', occupiedIds: [], canCreate: true, message: null }, { select: () => {}, create, cancel: () => {} });
  const form = document.querySelector<HTMLFormElement>('#create-player-form')!;
  expect(form.hidden).toBe(false);
  (document.querySelector<HTMLInputElement>('#player-name')!).value = 'Bea';
  form.requestSubmit();
  expect(create).toHaveBeenCalledWith('Bea', 'pj');
  view.destroy();
});

it('joins the selected available player explicitly', () => {
  document.body.innerHTML = '<main></main>';
  const game = fixtureGame();
  const select = vi.fn();
  const view = createPlayerView(document.querySelector('main')!, { game, selectedId: null, occupiedIds: [], canCreate: false, message: null }, { select, create: () => {}, cancel: () => {} });
  const existing = document.querySelector<HTMLSelectElement>('#player-existing')!;
  expect(existing.value).toBe('alex');
  document.querySelector<HTMLButtonElement>('#join-selected-player')!.click();
  expect(select).toHaveBeenCalledWith('alex');
  view.destroy();
});

it('renders escaped player names as text', () => {
  document.body.innerHTML = '<main></main>';
  const game = fixtureGame();
  game.players[0].name = '<img onerror=alert(1)>';
  const view = createPlayerView(document.querySelector('main')!, { game, selectedId: 'alex', occupiedIds: [], canCreate: true, message: null }, { select: () => {}, create: () => {}, cancel: () => {} });
  expect(document.querySelector('img')).toBeNull();
  expect(document.body.textContent).toContain('<img onerror=alert(1)>');
  view.destroy();
});
