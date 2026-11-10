// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { createMusicView } from '../../src/ui/music';
import type { AudioActions, AudioPanelView } from '../../src/ui/audio';

const track = { id: 'a'.repeat(64), name: 'Theme.mp3', type: 'audio/mpeg' as const, size: 1000, durationMs: 60_000, addedBy: 'alex', addedAt: '2026-11-10T10:00:00.000Z', gain: 100, gainAt: '2026-11-10T10:00:00.000Z', gainBy: 'alex' };
const view = (over: Partial<AudioPanelView> = {}): AudioPanelView => ({ tracks: [{ ...track, available: true, downloading: false, progress: 0, current: true, ended: false }], currentTrackId: track.id, playing: false, positionMs: 0, durationMs: 60_000, gain: 100, localVolume: 80, needsSound: false, connected: true, canAdd: true, canControl: true, canRemove: true, usageBytes: 1000, status: null, ...over });
function actions(over: Partial<AudioActions> = {}): AudioActions { return { add: vi.fn(async () => {}), remove: vi.fn(), select: vi.fn(), toggle: vi.fn(), seek: vi.fn(), setGain: vi.fn(), setLocalVolume: vi.fn(), enableSound: vi.fn(async () => {}), retry: vi.fn(), ...over }; }

beforeEach(() => { document.body.innerHTML = '<main></main>'; });

it('renders the library and current transport with accessible labels', () => {
  const v = view();
  const m = createMusicView(document.querySelector('main')!, v, actions());
  expect(document.querySelector('[data-track="' + track.id + '"]')!.textContent).toContain('Theme.mp3');
  expect(document.querySelector('#music-play')!.textContent).toBe('Start');
  expect(document.querySelector('#music-gain')!.getAttribute('aria-label')).toContain('everyone');
  expect(document.querySelector('#music-local')!.getAttribute('aria-label')).toContain('device');
  m.destroy();
});

it('delegates start/stop, seek, gain, local volume, upload, and remove', () => {
  const a = actions(); const m = createMusicView(document.querySelector('main')!, view(), a);
  document.querySelector<HTMLButtonElement>('#music-play')!.click();
  const progress = document.querySelector<HTMLInputElement>('#music-progress')!; progress.value = '30000'; progress.dispatchEvent(new Event('change', { bubbles: true }));
  const gain = document.querySelector<HTMLInputElement>('#music-gain')!; gain.value = '150'; gain.dispatchEvent(new Event('input', { bubbles: true })); gain.dispatchEvent(new Event('change', { bubbles: true }));
  const local = document.querySelector<HTMLInputElement>('#music-local')!; local.value = '30'; local.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector<HTMLButtonElement>('[data-track-remove]')!.click();
  expect(a.toggle).toHaveBeenCalledOnce();
  expect(a.seek).toHaveBeenCalledWith(30000);
  expect(a.setGain).toHaveBeenCalledWith(150);
  expect(a.setLocalVolume).toHaveBeenCalledWith(30);
  expect(a.remove).toHaveBeenCalledWith(track.id);
  m.destroy();
});

it('shows Enable sound only when needed and explains disabled controls', () => {
  const m = createMusicView(document.querySelector('main')!, view({ needsSound: true, canControl: false, connected: false }), actions());
  expect(document.querySelector('#music-enable-sound')).not.toBeNull();
  expect(document.querySelector<HTMLButtonElement>('#music-play')!.disabled).toBe(true);
  expect(document.querySelector('#music-status')!.textContent).toMatch(/connect/i);
  m.destroy();
});

it('preserves focus and slider drags across updates and does not rebuild unchanged rows', () => {
  const v = view(); const m = createMusicView(document.querySelector('main')!, v, actions());
  const row = document.querySelector('[data-track]');
  const gain = document.querySelector<HTMLInputElement>('#music-gain')!; gain.focus();
  m.update({ ...v, gain: 100, positionMs: 1000 });
  expect(document.querySelector('[data-track]')).toBe(row);
  expect(document.activeElement).toBe(gain);
  m.destroy();
});

it('allows selecting a peer-only track instead of disabling the control', () => {
  const a = actions();
  const missing = { ...track, available: false, downloading: false, progress: 0, current: false, ended: false };
  const m = createMusicView(document.querySelector('main')!, view({ tracks: [missing], currentTrackId: null, durationMs: 0 }), a);
  const select = document.querySelector<HTMLButtonElement>('[data-track-select]')!;
  expect(select.disabled).toBe(false);
  expect(select.textContent).toBe('Select');
  expect(select.getAttribute('aria-label')).toBe('Select Theme.mp3');
  select.click();
  expect(a.select).toHaveBeenCalledWith(track.id);
  m.destroy();
});

it('offers retry for a current track whose file is missing here', () => {
  const a = actions();
  const missing = { ...track, available: false, downloading: false, progress: 0, current: true, ended: false };
  const m = createMusicView(document.querySelector('main')!, view({ tracks: [missing], currentTrackId: track.id }), a);
  const retry = document.querySelector<HTMLButtonElement>('[data-track-retry]')!;
  expect(retry.hidden).toBe(false);
  retry.click();
  expect(a.retry).toHaveBeenCalledWith(track.id);
  m.destroy();
});

it('accepts shared gain changes on a focused idle slider but resists them while dragging', () => {
  const v = view(); const m = createMusicView(document.querySelector('main')!, v, actions());
  const gain = document.querySelector<HTMLInputElement>('#music-gain')!;
  gain.focus();
  m.update({ ...v, gain: 150 });
  expect(gain.value).toBe('150');
  gain.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  gain.value = '60';
  gain.dispatchEvent(new Event('input', { bubbles: true }));
  m.update({ ...v, gain: 150 });
  expect(gain.value).toBe('60');
  gain.dispatchEvent(new Event('pointerup', { bubbles: true }));
  m.update({ ...v, gain: 150 });
  expect(gain.value).toBe('150');
  m.destroy();
});

it('keeps the status text node across identical updates', () => {
  const v = view({ status: 'Saved to this browser.' });
  const m = createMusicView(document.querySelector('main')!, v, actions());
  const status = document.querySelector('#music-status')!;
  const text = status.firstChild;
  expect(text).not.toBeNull();
  m.update({ ...v });
  expect(status.firstChild).toBe(text);
  m.destroy();
});

it('explains the unseated control reason without blaming a host', () => {
  const m = createMusicView(document.querySelector('main')!, view({ connected: true, canControl: false }), actions());
  const hint = document.querySelector('.music-transport .music-hint')!.textContent ?? '';
  expect(hint).toMatch(/player/i);
  expect(hint).not.toMatch(/host/i);
  m.destroy();
});

it('forwards a file chosen through the hidden input and clears it', () => {
  const a = actions();
  const m = createMusicView(document.querySelector('main')!, view(), a);
  const input = document.querySelector<HTMLInputElement>('#music-file')!;
  const file = new File([new Uint8Array(4)], 'theme.mp3', { type: 'audio/mpeg' });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  expect(a.add).toHaveBeenCalledWith(file);
  expect(input.value).toBe('');
  m.destroy();
});
