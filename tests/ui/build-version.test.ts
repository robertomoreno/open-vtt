// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { mountApp } from '../../src/ui/app';
import { runtime } from '../helpers/game';

beforeEach(() => { document.body.innerHTML = '<main id="root"></main>'; });

const root = () => document.querySelector<HTMLElement>('#root')!;
const repo = { list: async () => ({ games: [], warnings: [] }) } as any;

it('shows the short build commit in the bottom corner', () => {
  const commit = '0123456789abcdef0123456789abcdef01234567';
  const app = mountApp(root(), { repository: repo, runtime: runtime(), build: commit });
  const badge = document.querySelector<HTMLElement>('#build-version')!;
  expect(badge.textContent).toBe('build 0123456');
  expect(badge.title).toBe(`Commit ${commit}`);
  expect(badge.dataset.commit).toBe(commit);
  app.destroy();
});

it('labels a local build when no commit is supplied', () => {
  const app = mountApp(root(), { repository: repo, runtime: runtime(), build: '' });
  const badge = document.querySelector<HTMLElement>('#build-version')!;
  expect(badge.textContent).toBe('build dev');
  expect(badge.title).toBe('Local development build');
  expect(badge.dataset.commit).toBe('');
  app.destroy();
});
