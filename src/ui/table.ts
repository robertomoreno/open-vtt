import { el, button, field, option, status } from './dom';
import type { DieSides } from '../game/types';
import type { PeerSessionView } from '../session/peer-types';

export type TableActions = {
  roll(sides: DieSides): void;
  download(): void;
  downloadRecovery(): void;
  connect(): void;
  disconnect(): void;
  leave(): void;
  choosePlayer(): void;
};
export type TableView = { update(view: PeerSessionView): void; destroy(): void };

export type TableViewData = PeerSessionView;
export type TableActionSet = TableActions;
export type TableProps = PeerSessionView;
export type TableViewModel = PeerSessionView;
export type TableViewProps = PeerSessionView;
export type TableData = PeerSessionView;

const dice: DieSides[] = [4, 6, 8, 10, 12, 20, 100];

export function createTableView(root: HTMLElement, view: PeerSessionView, actions: TableActions): TableView {
  const eyebrow = el('p', 'Your party’s shared space', 'eyebrow');
  const title = el('h1');
  const identity = el('p', '', 'lead');
  const snapshotLabel = el('p', '', 'muted');
  const message = status();
  const roster = el('ul', '', 'roster');
  const rolls = el('ol', '', 'rolls');
  rolls.setAttribute('aria-label', 'Roll history');

  const die = field('Die', 'die', 'select');
  const dieSelect = die.input as HTMLSelectElement;
  for (const n of dice) dieSelect.append(option(String(n), `d${n}`));
  dieSelect.value = '20';
  const roll = button('Roll the dice', () => actions.roll(Number(dieSelect.value) as DieSides), 'roll');
  roll.className = 'primary';

  const choosePlayer = button('Choose player', () => actions.choosePlayer(), 'choose-player');
  const connect = button('Connect', () => actions.connect(), 'open-room');
  const disconnect = button('Disconnect', () => actions.disconnect(), 'disconnect-room');
  const leave = button('Leave table', () => actions.leave(), 'leave');
  const download = button('Download game JSON', () => actions.download(), 'download');
  const downloadRecovery = button('Download recovery copy', () => actions.downloadRecovery(), 'download-recovery');

  const left = el('aside', '', 'panel');
  const right = el('section', '', 'panel');
  left.append(el('h2', 'Around the table'), roster, choosePlayer, connect, disconnect, leave, el('p', 'Players connect directly. Keep the host tab open.', 'muted'));
  right.append(el('h2', 'The dice have a story.'), el('p', 'One roll. Seen by everyone at the table.', 'muted'), rolls, die.wrapper, roll, download, downloadRecovery);

  const grid = el('div', '', 'room');
  grid.append(left, right);
  root.replaceChildren(eyebrow, title, identity, snapshotLabel, message, grid);

  let current: PeerSessionView = view;

  function renderRoster(v: PeerSessionView) {
    const game = v.game;
    roster.replaceChildren(...(game?.players ?? []).map((p) => {
      const online = v.onlinePlayerIds.includes(p.id);
      const you = p.id === v.localPlayerId ? ' (you)' : '';
      const li = el('li', `${p.name}${you} · ${p.role.toUpperCase()} · ${online ? 'Online' : 'Offline'}`);
      return li;
    }));
  }

  function renderRolls(v: PeerSessionView) {
    const game = v.game;
    rolls.replaceChildren(...(game?.rolls ?? []).slice().reverse().map((r) => {
      const row = el('li', '', 'roll');
      row.dataset.roll = r.id;
      const player = game!.players.find((p) => p.id === r.playerId);
      row.append(el('strong', String(r.value), 'die'), el('span', `${player?.name ?? 'Unknown'} rolled a d${r.sides}`), el('small', new Date(r.at).toLocaleTimeString()));
      return row;
    }));
    if (!(game?.rolls?.length)) rolls.append(el('li', 'A quiet table. Make the first roll.', 'muted'));
  }

  function apply(v: PeerSessionView) {
    current = v;
    const game = v.game;
    title.textContent = game?.name ?? 'Joining the table';
    const local = game?.players.find((p) => p.id === v.localPlayerId);
    identity.textContent = `${v.phase === 'local' ? 'Local' : v.phase}${local ? ` · ${local.name} · ${local.role.toUpperCase()}` : ''}`;
    snapshotLabel.textContent = v.phase === 'syncing' ? 'Synchronizing game state…' : '';
    // status
    let statusText = '';
    if (v.error) statusText = v.error;
    else if (v.connectionError) statusText = v.connectionError;
    else if (v.phase === 'offline') statusText = 'Offline. Local play continues; reconnect to sync.';
    else if (v.phase === 'waiting') statusText = 'Waiting for connection.';
    else if (v.phase === 'syncing') statusText = 'Syncing game state…';
    else if (v.conflicts.length) statusText = v.conflicts.map((c) => c.explanation).join(' ');
    else if (v.phase === 'ready') statusText = 'Connected and synchronized.';
    else if (v.phase === 'choosing') statusText = 'Choose your player.';
    message.textContent = statusText;

    roll.disabled = !v.canRoll;
    download.disabled = !game;
    downloadRecovery.hidden = !v.hasRecovery;
    downloadRecovery.disabled = !v.hasRecovery;
    connect.hidden = v.phase === 'ready' || v.phase === 'choosing' || v.phase === 'closed';
    disconnect.hidden = v.phase === 'local' || v.phase === 'closed';
    leave.disabled = false;

    renderRoster(v);
    renderRolls(v);
  }

  apply(view);
  return { update: apply, destroy() { root.replaceChildren(); } };
}
