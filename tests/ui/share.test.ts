// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createShareView } from '../../src/ui/share';

it('copies the link and tells the host to share it', async () => {
  document.body.innerHTML = '<main></main>';
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const view = createShareView(document.querySelector('main')!, { link: 'https://example/#room=abc', message: 'Room open.' }, { cancel: () => {} });
  await view.copy();
  expect(writeText).toHaveBeenCalledWith('https://example/#room=abc');
  expect(document.body.textContent).toContain('Link copied');
  view.destroy();
});

it('keeps copy failures usable with selectable text', async () => {
  document.body.innerHTML = '<main></main>';
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  const view = createShareView(document.querySelector('main')!, { link: 'https://example/#room=abc', message: '' }, { cancel: () => {} });
  await view.copy();
  expect(document.body.textContent).toContain('Select and copy');
  const output = document.querySelector<HTMLTextAreaElement>('#room-link-output')!;
  expect(output.readOnly).toBe(true);
  expect(output.selectionEnd).toBe(output.value.length);
  view.destroy();
});

it('hides the link controls when no link is available', () => {
  document.body.innerHTML = '<main></main>';
  const view = createShareView(document.querySelector('main')!, { link: null, message: 'The room could not be opened.' }, { cancel: () => {} });
  expect(document.querySelector<HTMLTextAreaElement>('#room-link-output')!.parentElement!.hidden).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('#copy-room-link')!.hidden).toBe(true);
  expect(document.body.textContent).toContain('The room could not be opened.');
  view.destroy();
});

it('closes the share panel from Done', () => {
  document.body.innerHTML = '<main></main>';
  const cancel = vi.fn();
  const view = createShareView(document.querySelector('main')!, { link: 'https://example/#room=abc', message: '' }, { cancel });
  document.querySelector<HTMLButtonElement>('#cancel-share')!.click();
  expect(cancel).toHaveBeenCalledOnce();
  view.destroy();
});
