// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => { document.body.innerHTML = '<main id="app"></main>'; localStorage.clear(); });

it('remounts the saved start screen after persisted pagehide and pageshow', async () => {
  await import('../../src/main');
  await vi.waitFor(() => expect(document.querySelector('#new-game')).not.toBeNull());
  document.querySelector<HTMLInputElement>('#game-name')!.value = 'Return to the table';
  document.querySelector<HTMLInputElement>('#creator-name')!.value = 'Alex';
  document.querySelector<HTMLFormElement>('#new-game')!.requestSubmit();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Return to the table'));
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  await vi.waitFor(() => expect(document.querySelectorAll('#new-game').length).toBe(1));
});