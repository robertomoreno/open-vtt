import { el, button, field, status } from './dom';

export type ShareData = { link: string | null; message: string };
export type ShareActions = { cancel(): void };
export type ShareView = { update(data: ShareData): void; copy(): Promise<void>; destroy(): void };

export function createShareView(root: HTMLElement, data: ShareData, actions: ShareActions): ShareView {
  const panel = el('article', '', 'panel');
  const title = el('h2', 'Share this room');
  const notice = el('p', 'Links contain temporary room credentials. Share them through a trusted channel. Public STUN discovers network addresses; it does not relay game data.', 'muted');
  const message = status();
  const output = field('Room link (selectable text)', 'room-link-output', 'textarea');
  const outputInput = output.input as HTMLTextAreaElement;
  outputInput.readOnly = true;
  const copy = button('Copy link', () => { void doCopy(); }, 'copy-room-link');
  const done = button('Done', () => actions.cancel(), 'cancel-share');

  panel.append(title, notice, message, output.wrapper, copy, done);
  root.replaceChildren(panel);

  async function doCopy() {
    if (!outputInput.value) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(outputInput.value);
      message.textContent = 'Link copied. Share it through a trusted channel.';
    } catch {
      outputInput.focus();
      outputInput.select();
      message.textContent = 'Select and copy the link manually. Clipboard access is unavailable.';
    }
  }

  function apply(next: ShareData) {
    message.textContent = next.message;
    output.wrapper.hidden = next.link === null;
    copy.hidden = next.link === null;
    if (next.link !== null) outputInput.value = next.link;
  }

  apply(data);
  return { update: apply, copy: doCopy, destroy() { root.replaceChildren(); } };
}
