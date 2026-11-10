import { describe, expect, it } from 'vitest';
import { AUDIO_BYTES, AUDIO_MAX_DURATION_MS } from '../../src/network/limits';
import {
  comparePlaybackCommands, createAudioTrack, latestPlaybackCommand, mergeAudioTrack,
  normalizeAudioType, sha256Hex, validateAudioTrack, validatePlaybackCommand,
} from '../../src/game/audio';

const AT = '2026-11-10T10:00:00.000Z';
const ID = 'a'.repeat(64);
const input = { id: ID, name: 'Battle theme.mp3', type: 'audio/mpeg' as const, size: 4_000_000, durationMs: 180_000 };

describe('audio domain', () => {
  it('creates a valid track with default shared gain and validates it', () => {
    const track = createAudioTrack(input, 'alex', AT);
    expect(track).toMatchObject({ ...input, gain: 100, gainAt: AT, gainBy: 'alex', addedAt: AT, addedBy: 'alex' });
    expect(validateAudioTrack(track)).toEqual(track);
  });

  it('rejects oversized files, empty files, bad durations, and unsupported types', () => {
    expect(() => createAudioTrack({ ...input, size: AUDIO_BYTES + 1 }, 'alex', AT)).toThrow(/size/i);
    expect(() => createAudioTrack({ ...input, size: 0 }, 'alex', AT)).toThrow(/size/i);
    expect(() => createAudioTrack({ ...input, durationMs: 0 }, 'alex', AT)).toThrow(/duration/i);
    expect(() => createAudioTrack({ ...input, durationMs: AUDIO_MAX_DURATION_MS + 1 }, 'alex', AT)).toThrow(/duration/i);
    expect(() => createAudioTrack({ ...input, type: 'audio/midi' as any }, 'alex', AT)).toThrow(/type/i);
    expect(() => createAudioTrack({ ...input, id: 'not-a-hash' }, 'alex', AT)).toThrow(/ID/i);
  });

  it('normalizes common MIME aliases', () => {
    expect(normalizeAudioType('audio/mp3')).toBe('audio/mpeg');
    expect(normalizeAudioType('audio/x-wav')).toBe('audio/wav');
    expect(normalizeAudioType('audio/x-m4a')).toBe('audio/mp4');
    expect(normalizeAudioType('text/plain')).toBeNull();
  });

  it('merges cosmetic fields by earliest add and gain by newest edit', () => {
    const a = createAudioTrack(input, 'alex', AT);
    const b = { ...a, name: 'Renamed.mp3', addedAt: '2026-11-10T11:00:00.000Z', addedBy: 'bea', gain: 150, gainAt: '2026-11-10T12:00:00.000Z', gainBy: 'bea' };
    const merged = mergeAudioTrack(a, b);
    expect(merged.name).toBe('Battle theme.mp3');
    expect(merged.gain).toBe(150);
    expect(merged.gainBy).toBe('bea');
  });

  it('orders playback commands by revision then participant id', () => {
    const cmd = (rev: number, participantId: string) => validatePlaybackCommand({ id: `c${rev}`, rev, participantId, trackId: ID, playing: true, positionMs: 0, at: AT });
    expect(comparePlaybackCommands(cmd(2, 'a'), cmd(1, 'z'))).toBeGreaterThan(0);
    expect(comparePlaybackCommands(cmd(2, 'a'), cmd(2, 'b'))).toBeLessThan(0);
    expect(latestPlaybackCommand([cmd(1, 'a'), cmd(2, 'b'), cmd(2, 'a')])!.participantId).toBe('b');
  });

  it('hashes exact bytes with SHA-256', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
