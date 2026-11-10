// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { AUDIO_BYTES } from '../../src/network/limits';
import { prepareAudioFile } from '../../src/ui/audio-file';

const file = (name = 'theme.mp3', type = 'audio/mpeg', size = 4) => new File([new Uint8Array(size)], name, { type });

it('prepares a supported file with a content hash and duration', async () => {
  const prepared = await prepareAudioFile(file(), { probeDuration: async () => 60_000, canPlay: () => true });
  expect(prepared.input).toMatchObject({ name: 'theme.mp3', type: 'audio/mpeg', size: 4, durationMs: 60_000 });
  expect(prepared.input.id).toMatch(/^[0-9a-f]{64}$/);
  expect(prepared.meta.trackId).toBe(prepared.input.id);
});

it('normalizes aliases and falls back to the extension', async () => {
  const prepared = await prepareAudioFile(file('theme.mp3', 'audio/mp3'), { probeDuration: async () => 1000, canPlay: () => true });
  expect(prepared.input.type).toBe('audio/mpeg');
  const empty = await prepareAudioFile(file('theme.mp3', ''), { probeDuration: async () => 1000, canPlay: () => true });
  expect(empty.input.type).toBe('audio/mpeg');
});

it('rejects oversized, empty, unsupported, and unplayable files', async () => {
  await expect(prepareAudioFile(file('big.mp3', 'audio/mpeg', AUDIO_BYTES + 1), { probeDuration: async () => 1, canPlay: () => true })).rejects.toThrow(/10 MB|size/i);
  await expect(prepareAudioFile(file('empty.mp3', 'audio/mpeg', 0), { probeDuration: async () => 1, canPlay: () => true })).rejects.toThrow(/empty/i);
  await expect(prepareAudioFile(file('x.txt', 'text/plain'), { probeDuration: async () => 1, canPlay: () => true })).rejects.toThrow(/audio/i);
  await expect(prepareAudioFile(file(), { probeDuration: async () => 1, canPlay: () => false })).rejects.toThrow(/browser/i);
});

it('rejects a file whose duration cannot be read', async () => {
  await expect(prepareAudioFile(file(), { probeDuration: async () => { throw new Error('cannot decode'); }, canPlay: () => true })).rejects.toThrow(/duration|decode/i);
});
