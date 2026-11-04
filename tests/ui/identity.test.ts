// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createIdentityView } from '../../src/ui/identity';

it('suggests remembered available identities but excludes occupied players', () => {
  document.body.innerHTML = '<main></main>';
  const claim = vi.fn();
  const lobby = { sessionId: 's', gameId: 'g', gameName: 'Game', players: [{ id: 'a', name: 'Alex', role: 'gm' as const, online: true }, { id: 'b', name: 'Bea', role: 'pj' as const, online: false }] };
  const view = createIdentityView(document.querySelector('main')!, lobby, 'b', { claim });
  expect(document.querySelector<HTMLSelectElement>('#claim-player')!.value).toBe('b');
  expect(document.querySelector<HTMLOptionElement>('option[value=a]')!.disabled).toBe(true);
  view.destroy();
});