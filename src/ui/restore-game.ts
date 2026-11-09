import { el, button, field, option, status } from './dom';
import type { WorkspaceSnapshot } from '../game/sync-types';

export type RestoreGameData = { snapshot: WorkspaceSnapshot; replace: boolean; selectedId: string | null };
export type RestoreGameActions = { open(id: string): void; cancel(): void };
export type RestoreGameView = { update(data: RestoreGameData): void; destroy(): void };

export type RestoreGameViewData = RestoreGameData;
export type RestoreGameActionSet = RestoreGameActions;
export type RestoreGameProps = RestoreGameData;
export type RestoreGameViewModel = RestoreGameData;
export type RestoreGameViewState = RestoreGameData;
export type RestoreGameViewProps = RestoreGameData;

export function createRestoreGameView(root: HTMLElement, data: RestoreGameData, actions: RestoreGameActions): RestoreGameView {
  const snapshot = data.snapshot;
  const game = snapshot.game;
  const panel = el('article', '', 'panel');
  const title = el('h1', game.name);
  const eyebrow = el('p', 'A new session, a familiar story.', 'eyebrow');
  const info = el('p', `${game.players.length} players · ${game.rolls.length} recent rolls. No old connections will be restored.`, 'muted');
  const replaceNotice = data.replace ? el('p', 'A game with this ID already exists. Opening this file replaces that browser save; cancel keeps it unchanged.', 'notice') : null;

  const playerField = field('Host as player', 'restore-player', 'select');
  const playerSelect = playerField.input as HTMLSelectElement;
  playerSelect.append(...game.players.map((p) => option(p.id, `${p.name} · ${p.role.toUpperCase()}`)));
  if (data.selectedId && game.players.some((p) => p.id === data.selectedId)) {
    playerSelect.value = data.selectedId;
  } else if (game.players.length) {
    playerSelect.value = game.players[0].id;
  }

  const open = button(data.replace ? 'Replace saved game and open' : 'Open game', () => {}, 'open-restore');
  open.type = 'submit';
  open.className = 'primary';
  const cancel = button('Cancel', () => actions.cancel(), 'cancel-restore');

  const form = el('form', '', 'panel');
  form.append(info);
  if (replaceNotice) form.append(replaceNotice);
  form.append(playerField.wrapper, open, cancel);
  form.onsubmit = (e) => {
    e.preventDefault();
    actions.open(playerSelect.value);
  };

  root.replaceChildren(eyebrow, title, panel);
  panel.append(form);

  let current = data;
  function apply(next: RestoreGameData) {
    current = next;
    // update select value
    if (next.selectedId && next.snapshot.game.players.some((p) => p.id === next.selectedId)) {
      playerSelect.value = next.selectedId;
    }
  }
  apply(data);
  return { update: apply, destroy() { root.replaceChildren(); } };
}
