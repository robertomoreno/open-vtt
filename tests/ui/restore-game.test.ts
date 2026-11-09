// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createRestoreGameView } from '../../src/ui/restore-game';
import { createTestWorkspace } from '../helpers/workspace';

it('does not render restore-name', () => {
  document.body.innerHTML = '<main></main>';
  const snapshot = createTestWorkspace('a').getSnapshot();
  const open = vi.fn();
  const view = createRestoreGameView(document.querySelector('main')!, { snapshot, replace: false, selectedId: 'alex' }, { open, cancel: () => {} });
  expect(document.querySelector('#restore-name')).toBeNull();
  const form = document.querySelector<HTMLFormElement>('form')!;
  form.requestSubmit();
  expect(open).toHaveBeenCalled();
  view.destroy();
});

it('shows replacement notice when replace is true', () => {
  document.body.innerHTML = '<main></main>';
  const snapshot = createTestWorkspace('a').getSnapshot();
  const view = createRestoreGameView(document.querySelector('main')!, { snapshot, replace: true, selectedId: 'alex' }, { open: () => {}, cancel: () => {} });
  expect(document.body.textContent).toContain('Replace saved game');
  view.destroy();
});

it('does not offer an offline new-GM identity', () => {
  document.body.innerHTML = '<main></main>';
  const snapshot = createTestWorkspace('a').getSnapshot();
  const view = createRestoreGameView(document.querySelector('main')!, { snapshot, replace: false, selectedId: 'alex' }, { open: () => {}, cancel: () => {} });
  expect(document.querySelector('#restore-player option[value=""]')).toBeNull();
  view.destroy();
});
