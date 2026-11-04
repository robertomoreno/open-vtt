// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createPlayerView } from '../../src/ui/player';
import { fixtureGame } from '../helpers/game';

it('does not submit offline creation', () => {
  document.body.innerHTML = '<main></main>';
  const game = fixtureGame();
  const create = vi.fn();
  const view = createPlayerView(document.querySelector('main')!, { game, selectedId: null, occupiedIds: [], canCreate: false, message: null }, { select: () => {}, create, cancel: () => {} });
  const form = document.querySelector<HTMLFormElement>('form')!;
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  expect(create).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLButtonElement>('#create-player')!.disabled).toBe(true);
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
