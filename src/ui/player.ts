import { el, button, field, status } from './dom';
import type { Game, Role } from '../game/types';

export type PlayerData = { game: Game; selectedId: string | null; occupiedIds: string[]; canCreate: boolean; message: string | null };
export type PlayerActions = { select(id: string): void; create(name: string, role: Role): void; cancel(): void };
export type PlayerView = { update(data: PlayerData): void; destroy(): void };

export type PlayerViewData = PlayerData;
export type PlayerActionSet = PlayerActions;
export type PlayerProps = PlayerData;
export type PlayerViewModel = PlayerData;
export type PlayerViewState = PlayerData;
export type PlayerViewProps = PlayerData;

export function createPlayerView(root: HTMLElement, data: PlayerData, actions: PlayerActions): PlayerView {
  const panel = el('article', '', 'panel');
  const title = el('h2', 'Choose your player');
  const gameName = el('p', data.game.name, 'eyebrow');
  const message = status();
  const roster = el('ul', '', 'roster');

  const existingField = field('Available saved player', 'player-existing', 'select');
  const existingSelect = existingField.input as HTMLSelectElement;
  const nameField = field('Player name', 'player-name');
  const nameInput = nameField.input as HTMLInputElement;
  const roleField = field('Role', 'player-role', 'select');
  const roleSelect = roleField.input as HTMLSelectElement;
  const pjOption = el('option', 'PJ · Player'); pjOption.value = 'pj';
  const gmOption = el('option', 'GM · Game master'); gmOption.value = 'gm';
  roleSelect.append(pjOption, gmOption);

  const createButton = button('Create player', () => {}, 'create-player');
  createButton.type = 'submit';
  const form = el('form', '', 'panel');
  form.append(el('h2', 'A new face'), nameField.wrapper, roleField.wrapper, createButton, el('p', 'Roles label players; they do not grant host authority.', 'muted'));
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!current.canCreate || createButton.disabled) return;
    actions.create(nameInput.value, roleSelect.value as Role);
  };
  const cancel = button('Cancel', () => actions.cancel(), 'cancel-player');

  const saved = el('article', '', 'panel');
  saved.append(el('h2', 'A familiar face'), existingField.wrapper, el('p', 'A remembered choice is a convenience, not proof of identity.', 'muted'));

  panel.append(gameName, title, message, saved, form, roster, cancel);
  root.replaceChildren(panel);

  let current: PlayerData = data;

  function renderRoster(next: PlayerData) {
    roster.replaceChildren(...next.game.players.map((p) => {
      const li = el('li', `${p.name} · ${p.role.toUpperCase()} · ${next.occupiedIds.includes(p.id) ? 'Occupied' : 'Available'}`);
      return li;
    }));
  }

  function apply(next: PlayerData) {
    current = next;
    message.textContent = next.message ?? '';
    const available = next.game.players;
    existingSelect.replaceChildren(...available.map((p) => {
      const o = el('option', `${p.name} · ${p.role.toUpperCase()} · ${next.occupiedIds.includes(p.id) ? 'Occupied' : 'Available'}`);
      o.value = p.id;
      o.disabled = next.occupiedIds.includes(p.id);
      return o;
    }));
    if (next.selectedId !== null && available.some((p) => p.id === next.selectedId)) {
      existingSelect.value = next.selectedId;
    } else if (available.length) {
      const firstAvailable = available.find((p) => !next.occupiedIds.includes(p.id));
      if (firstAvailable) existingSelect.value = firstAvailable.id;
    }
    existingSelect.onchange = () => {
      if (existingSelect.value) actions.select(existingSelect.value);
    };
    createButton.disabled = !next.canCreate;
    renderRoster(next);
  }

  apply(data);
  return { update: apply, destroy() { root.replaceChildren(); } };
}
