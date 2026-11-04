import { el, button, field, status } from './dom';

export type ShareMode = 'open' | 'join' | 'active';
export type ShareData = { mode: ShareMode; link: string | null; message: string; canConnect: boolean };
export type ShareActions = { connect(): void; cancel(): void };
export type ShareView = { update(data: ShareData): void; destroy(): void };

export type ShareViewData = ShareData;
export type ShareActionSet = ShareActions;
export type ShareProps = ShareData;
export type ShareViewModel = ShareData;
export type ShareViewState = ShareData;
export type ShareViewProps = ShareData;

export function createShareView(root: HTMLElement, data: ShareData, actions: ShareActions): ShareView {
  const panel = el('article', '', 'panel');
  const title = el('h2', 'Share this room');
  const notice = el('p', 'Public Google STUN discovers network addresses; it does not relay game data. Links contain temporary credentials and network details: use a trusted channel.', 'muted');
  const message = status();
  const output = field('Room link (selectable text)', 'room-link-output', 'textarea');
  const outputInput = output.input as HTMLTextAreaElement;
  outputInput.readOnly = true;
  const copy = button('Copy link', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(outputInput.value);
      message.textContent = 'Link copied. Share it through a trusted channel.';
    } catch {
      outputInput.focus();
      outputInput.select();
      message.textContent = 'Select and copy the text manually. Clipboard access is unavailable.';
    }
  }, 'copy-room-link');
  const openRoom = button('Open room', () => actions.connect(), 'open-room');
  const joinRoom = button('Join room', () => actions.connect(), 'join-room');
  const disconnect = button('Disconnect', () => actions.cancel(), 'disconnect-room');
  const cancel = button('Cancel', () => actions.cancel(), 'cancel-share');

  panel.append(title, notice, message, output.wrapper, copy, openRoom, joinRoom, disconnect, cancel);
  root.replaceChildren(panel);

  function apply(next: ShareData) {
    message.textContent = next.message;
    openRoom.hidden = next.mode !== 'open';
    joinRoom.hidden = next.mode !== 'join';
    output.wrapper.hidden = next.link === null;
    copy.hidden = next.link === null;
    disconnect.hidden = next.mode !== 'active';
    cancel.hidden = false;
    openRoom.disabled = !next.canConnect;
    joinRoom.disabled = !next.canConnect;
    if (next.link !== null) outputInput.value = next.link;
  }
  apply(data);
  return { update: apply, destroy() { root.replaceChildren(); } };
}
