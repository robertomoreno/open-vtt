// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createShareView } from '../../src/ui/share';

it('does not call connect before clicking (privacy consent)', () => {
  document.body.innerHTML = '<main></main>';
  const connect = vi.fn();
  const view = createShareView(document.querySelector('main')!, { mode: 'open', link: null, message: 'Read notice', canConnect: true }, { connect, cancel: () => {} });
  expect(connect).not.toHaveBeenCalled();
  document.querySelector<HTMLButtonElement>('#open-room')!.click();
  expect(connect).toHaveBeenCalledOnce();
  view.destroy();
});

it('keeps copy failures usable with selectable text', async () => {
  document.body.innerHTML = '<main></main>';
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  const view = createShareView(document.querySelector('main')!, { mode: 'active', link: 'https://example/#room=abc', message: '', canConnect: true }, { connect: () => {}, cancel: () => {} });
  document.querySelector<HTMLButtonElement>('#copy-room-link')!.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Select and copy'));
  const output = document.querySelector<HTMLTextAreaElement>('#room-link-output')!;
  expect(output.readOnly).toBe(true);
  expect(output.selectionEnd).toBe(output.value.length);
  view.destroy();
});

it('lets all participants share an active link', () => {
  document.body.innerHTML = '<main></main>';
  const view = createShareView(document.querySelector('main')!, { mode: 'active', link: 'https://example/#room=abc', message: 'Active', canConnect: true }, { connect: () => {}, cancel: () => {} });
  const output = document.querySelector<HTMLTextAreaElement>('#room-link-output')!;
  expect(output.value).toBe('https://example/#room=abc');
  expect(document.querySelector('#copy-room-link')).not.toBeNull();
  view.destroy();
});
