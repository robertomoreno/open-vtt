import { el, button, field, option, status } from './dom';
import type { DieSides, Player, Role, Roll } from '../game/types';
import type { ChatDraft, PeerSessionView } from '../session/peer-types';
import { canSeeChat } from '../game/chat';
import type { ChatImage, ChatImageInput, ChatMessage } from '../game/chat';
import { CHAT_RECORDS, CHAT_TEXT_CHARS } from '../network/limits';

export type TableActions = {
  roll(sides: DieSides): void;
  download(): void;
  downloadRecovery(): void;
  share(): void;
  disconnect(): void;
  leave(): void;
  choosePlayer(): void;
  createPlayer(name: string, role: Role): void;
  sendMessage(draft: ChatDraft): boolean;
  prepareImage(file: File): Promise<ChatImageInput>;
};
export type TableView = { update(view: PeerSessionView): void; destroy(): void };

export type TableViewData = PeerSessionView;
export type TableActionSet = TableActions;
export type TableProps = PeerSessionView;
export type TableViewModel = PeerSessionView;
export type TableViewProps = PeerSessionView;
export type TableData = PeerSessionView;

const dice: DieSides[] = [4, 6, 8, 10, 12, 20, 100];
const UNKNOWN_AUTHOR = 'Former player';

type LedgerEntry =
  | { kind: 'roll'; id: string; at: string; roll: Roll }
  | { kind: 'chat'; id: string; at: string; message?: ChatMessage; image?: ChatImage };

function compareEntries(a: LedgerEntry, b: LedgerEntry): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}

export function createTableView(root: HTMLElement, view: PeerSessionView, actions: TableActions): TableView {
  const eyebrow = el('p', 'Your party’s shared space', 'eyebrow');
  const title = el('h1');
  const identity = el('p', '', 'lead');
  const snapshotLabel = el('p', '', 'muted');
  const message = status();
  const roster = el('ul', '', 'roster');
  const ledger = el('ol', '', 'rolls ledger');
  ledger.setAttribute('aria-label', 'Table ledger');

  const die = field('Die', 'die', 'select');
  const dieSelect = die.input as HTMLSelectElement;
  for (const n of dice) dieSelect.append(option(String(n), `d${n}`));
  dieSelect.value = '20';
  const roll = button('Roll the dice', () => actions.roll(Number(dieSelect.value) as DieSides), 'roll');
  roll.className = 'primary';

  const choosePlayer = button('Choose player', () => actions.choosePlayer(), 'choose-player');
  const room = button('Connect', () => actions.share(), 'open-room');
  const disconnect = button('Disconnect', () => actions.disconnect(), 'disconnect-room');
  const leave = button('Leave table', () => actions.leave(), 'leave');
  const download = button('Download game JSON', () => actions.download(), 'download');
  const downloadRecovery = button('Download recovery copy', () => actions.downloadRecovery(), 'download-recovery');
  const waiting = status();
  waiting.id = 'waiting-players';
  const addName = field('New player name', 'new-player-name');
  const addRole = field('New player role', 'new-player-role', 'select');
  addRole.input.append(option('pj', 'PJ · Player'), option('gm', 'GM · Game master'));
  addRole.input.value = 'pj';
  const add = button('Add player', () => {}, 'add-player');
  add.type = 'submit';
  const addForm = el('form');
  addForm.id = 'add-player-form';
  addForm.append(el('h3', 'Add a player'), addName.wrapper, addRole.wrapper, add);
  addForm.onsubmit = (e) => {
    e.preventDefault();
    if (add.disabled) return;
    actions.createPlayer(addName.input.value, addRole.input.value as Role);
    addName.input.value = '';
  };

  // Chat composer. Built once so a session update can never lose the draft or focus.
  const chatForm = el('form', '', 'chat');
  chatForm.id = 'chat-form';
  const messageField = field('Message', 'chat-message', 'textarea');
  const chatInput = messageField.input as HTMLTextAreaElement;
  chatInput.maxLength = CHAT_TEXT_CHARS;
  chatInput.rows = 3;

  const privateField = field('Private message', 'chat-private', 'input');
  const privateToggle = privateField.input as HTMLInputElement;
  privateToggle.type = 'checkbox';
  privateField.wrapper.className = 'chat-private-toggle';

  const recipients = el('fieldset', '', 'chat-recipients');
  recipients.hidden = true;
  const recipientList = el('div', '', 'chat-recipient-list');
  recipients.append(el('legend', 'Send to'), recipientList);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'chat-image-input';
  fileInput.accept = 'image/png,image/jpeg,image/webp';
  fileInput.hidden = true;
  fileInput.setAttribute('aria-label', 'Image file');
  const attach = button('Attach image', () => fileInput.click(), 'chat-attach');

  const preview = el('div', '', 'chat-preview');
  preview.hidden = true;
  const previewBody = el('div', '', 'chat-preview-body');
  const removeImage = button('Remove image', () => clearImage(), undefined);
  removeImage.setAttribute('aria-label', 'Remove image');
  preview.append(previewBody, removeImage);

  const chatStatus = status();
  chatStatus.id = 'chat-status';
  const send = button('Send', () => {}, 'chat-send');
  send.type = 'submit';
  send.className = 'primary';

  const attachRow = el('div', '', 'chat-actions');
  attachRow.append(attach, send);
  chatForm.append(el('h3', 'Table chat'), messageField.wrapper, privateField.wrapper, recipients, attachRow, fileInput, preview, chatStatus);

  const left = el('aside', '', 'panel');
  const right = el('section', '', 'panel');
  left.append(el('h2', 'Around the table'), waiting, roster, addForm, choosePlayer, room, disconnect, leave, el('p', 'Players connect directly. Keep the host tab open.', 'muted'));
  right.append(el('h2', 'The dice have a story.'), el('p', 'One roll. Seen by everyone at the table.', 'muted'), ledger, chatForm, die.wrapper, roll, download, downloadRecovery);

  const grid = el('div', '', 'room');
  grid.append(left, right);
  root.replaceChildren(eyebrow, title, identity, snapshotLabel, message, grid);

  let current: PeerSessionView = view;
  let ledgerSignature: string | null = null;
  let recipientKey: string | null = null;
  const selected = new Set<string>();
  let pendingImage: ChatImageInput | null = null;
  let imageRequest = 0;

  function authorName(players: Map<string, Player>, id: string): string {
    return players.get(id)?.name ?? UNKNOWN_AUTHOR;
  }

  function entrySignature(e: LedgerEntry): unknown[] {
    if (e.kind === 'roll') return [e.id, 'roll', e.roll.value, e.roll.sides, e.roll.playerId];
    const recipients = e.message?.recipients ?? e.image?.recipients ?? null;
    return [e.id, 'chat', e.message?.text ?? '', e.image ? 1 : 0, recipients];
  }

  function chatRow(
    data: { id: string; at: string; message?: ChatMessage; image?: ChatImage },
    players: Map<string, Player>,
  ): HTMLElement {
    const record = data.message ?? data.image!;
    const row = el('li', '', 'ledger-entry chat');
    row.dataset.chat = data.id;
    const meta = el('div', '', 'chat-meta');
    meta.append(el('strong', authorName(players, record.playerId), 'chat-author'), el('small', new Date(data.at).toLocaleTimeString()));
    if (record.recipients) {
      meta.append(el('span', `Private · ${record.recipients.map((id) => authorName(players, id)).join(', ')}`, 'chat-private-label'));
    }
    row.append(meta);
    if (data.message) row.append(el('p', data.message.text, 'chat-text'));
    if (data.image) {
      const image = el('img', '', 'chat-image');
      image.src = data.image.dataUrl;
      image.alt = `Image from ${authorName(players, data.image.playerId)}`;
      row.append(image);
    }
    return row;
  }

  function rollRow(roll: Roll, players: Map<string, Player>): HTMLElement {
    const row = el('li', '', 'ledger-entry roll');
    row.dataset.roll = roll.id;
    row.append(
      el('strong', String(roll.value), 'die'),
      el('span', `${authorName(players, roll.playerId)} rolled a d${roll.sides}`),
      el('small', new Date(roll.at).toLocaleTimeString()),
    );
    return row;
  }

  function renderLedger(v: PeerSessionView) {
    const players = new Map((v.game?.players ?? []).map((p) => [p.id, p]));
    const merged = new Map<string, { message?: ChatMessage; image?: ChatImage }>();
    for (const m of v.messages) {
      if (!canSeeChat(m.recipients, v.localPlayerId)) continue;
      merged.set(m.id, { ...merged.get(m.id), message: m });
    }
    for (const i of v.liveImages) {
      if (!canSeeChat(i.recipients, v.localPlayerId)) continue;
      merged.set(i.id, { ...merged.get(i.id), image: i });
    }
    const chatEntries: LedgerEntry[] = [];
    for (const [id, data] of merged) {
      const record = data.message ?? data.image;
      if (!record) continue;
      chatEntries.push({ kind: 'chat', id, at: record.at, message: data.message, image: data.image });
    }
    chatEntries.sort(compareEntries);
    const visibleChats = chatEntries.slice(-CHAT_RECORDS);
    const rollEntries: LedgerEntry[] = (v.game?.rolls ?? [])
      .slice(-CHAT_RECORDS)
      .map((r) => ({ kind: 'roll', id: r.id, at: r.at, roll: r }));
    const entries = [...visibleChats, ...rollEntries].sort(compareEntries);

    const signature = JSON.stringify([
      [...players.values()].map((p) => `${p.id}:${p.name}`),
      entries.map(entrySignature),
    ]);
    if (signature === ledgerSignature) return;
    const atBottom = ledger.scrollHeight - ledger.scrollTop - ledger.clientHeight <= 4;
    const nodes: HTMLElement[] = entries.map((entry) => entry.kind === 'chat'
      ? chatRow({ id: entry.id, at: entry.at, message: entry.message, image: entry.image }, players)
      : rollRow(entry.roll, players));
    if (!nodes.length) nodes.push(el('li', 'A quiet table. Say hello or make the first roll.', 'muted'));
    ledger.replaceChildren(...nodes);
    if (atBottom) ledger.scrollTop = ledger.scrollHeight;
    ledgerSignature = signature;
  }

  function rebuildRecipients(v: PeerSessionView) {
    const players = v.game?.players ?? [];
    const ids = new Set(players.map((p) => p.id));
    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
    const key = `${v.localPlayerId ?? ''}|${players.map((p) => `${p.id}:${p.name}:${p.role}`).join(',')}`;
    if (key === recipientKey) return;
    recipientKey = key;
    recipientList.replaceChildren(...players.map((p) => {
      const label = el('label', p.name, 'chat-recipient');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = `chat-recipient-${p.id}`;
      input.value = p.id;
      const local = p.id === v.localPlayerId;
      input.checked = local || selected.has(p.id);
      input.disabled = local || !v.canChat;
      label.htmlFor = input.id;
      label.prepend(input);
      return label;
    }));
  }

  function updateSend(v: PeerSessionView = current) {
    send.disabled = !v.canChat || (!chatInput.value.trim() && !pendingImage);
  }

  function showPreview(image: ChatImageInput) {
    previewBody.replaceChildren();
    const img = el('img', '', 'chat-preview-image');
    img.src = image.dataUrl;
    img.alt = `Attached image ${image.name}`;
    previewBody.append(img, el('span', image.name, 'muted'));
    preview.hidden = false;
  }

  function clearImage() {
    imageRequest++;
    pendingImage = null;
    previewBody.replaceChildren();
    preview.hidden = true;
    chatStatus.textContent = '';
    updateSend();
  }

  async function handleImageFile(file: File | null | undefined) {
    if (!file || !file.type.startsWith('image/')) return;
    const request = ++imageRequest;
    try {
      const prepared = await actions.prepareImage(file);
      if (request !== imageRequest) return;
      pendingImage = prepared;
      showPreview(prepared);
      chatStatus.textContent = '';
    } catch (error) {
      if (request !== imageRequest) return;
      chatStatus.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      fileInput.value = '';
      updateSend();
    }
  }

  function submitChat() {
    if (send.disabled) return;
    const accepted = actions.sendMessage({
      text: chatInput.value.trim(),
      recipients: privateToggle.checked ? [...selected].sort() : null,
      image: pendingImage ?? undefined,
    });
    if (!accepted) {
      chatStatus.textContent = 'The message was not sent. Try again.';
      return;
    }
    chatInput.value = '';
    pendingImage = null;
    imageRequest++;
    previewBody.replaceChildren();
    preview.hidden = true;
    privateToggle.checked = false;
    recipients.hidden = true;
    selected.clear();
    for (const input of recipientList.querySelectorAll<HTMLInputElement>('input')) {
      if (input.value !== current.localPlayerId) input.checked = false;
    }
    chatStatus.textContent = '';
    updateSend();
  }

  function syncComposer(v: PeerSessionView) {
    rebuildRecipients(v);
    chatInput.disabled = !v.canChat;
    attach.disabled = !v.canChat;
    privateToggle.disabled = !v.canChat;
    for (const input of recipientList.querySelectorAll<HTMLInputElement>('input')) {
      input.disabled = input.value === v.localPlayerId || !v.canChat;
    }
    updateSend(v);
  }

  chatForm.onsubmit = (event) => {
    event.preventDefault();
    submitChat();
  };
  chatInput.addEventListener('input', () => updateSend());
  chatInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    submitChat();
  });
  privateToggle.addEventListener('change', () => {
    recipients.hidden = !privateToggle.checked;
    updateSend();
  });
  recipientList.addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement | null;
    if (!target || target.type !== 'checkbox') return;
    if (target.checked) selected.add(target.value);
    else selected.delete(target.value);
    updateSend();
  });
  fileInput.addEventListener('change', () => {
    void handleImageFile(fileInput.files?.[0]);
  });
  chatForm.addEventListener('dragover', (event) => event.preventDefault());
  chatForm.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) void handleImageFile(file);
  });

  function renderRoster(v: PeerSessionView) {
    const game = v.game;
    roster.replaceChildren(...(game?.players ?? []).map((p) => {
      const online = v.onlinePlayerIds.includes(p.id);
      const you = p.id === v.localPlayerId ? ' (you)' : '';
      const li = el('li', `${p.name}${you} · ${p.role.toUpperCase()} · ${online ? 'Online' : 'Offline'}`);
      return li;
    }));
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
    const reconnect = v.phase === 'local' || v.phase === 'offline';
    room.textContent = !v.hasRoomLink ? 'Connect' : reconnect ? 'Reconnect' : 'Share link';
    room.hidden = !game || v.phase === 'closed';
    disconnect.hidden = v.phase === 'local' || v.phase === 'closed';
    leave.disabled = false;

    const isGm = game?.players.some((p) => p.id === v.localPlayerId && p.role === 'gm') ?? false;
    addForm.hidden = !isGm;
    add.disabled = !v.canCreatePlayer;
    addName.input.disabled = !v.canCreatePlayer;
    addRole.input.disabled = !v.canCreatePlayer;
    const freePlayers = game ? game.players.filter((p) => !v.onlinePlayerIds.includes(p.id)).length : 0;
    const waitingCount = v.unseatedParticipantCount;
    const showWaiting = isGm && waitingCount > 0 && freePlayers === 0;
    waiting.hidden = !showWaiting;
    waiting.textContent = showWaiting ? `${waitingCount} participant${waitingCount === 1 ? '' : 's'} waiting for a character. Add one below.` : '';

    renderRoster(v);
    renderLedger(v);
    syncComposer(v);
  }

  apply(view);
  return { update: apply, destroy() { root.replaceChildren(); } };
}
