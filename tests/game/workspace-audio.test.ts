import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { AUDIO_TOMBSTONES, AUDIO_TRACKS } from '../../src/network/limits';
import { createAudioTrack, mergeAudioTrack } from '../../src/game/audio';
import { createWorkspace, validateWorkspaceSnapshot } from '../../src/game/workspace';
import { createTestWorkspace, namedRuntime } from '../helpers/workspace';

const AT = '2026-11-10T10:00:00.000Z';
const track = (n: number) => createAudioTrack({ id: `${'a'.repeat(60)}${String(n).padStart(4, '0')}`, name: `Track ${n}.mp3`, type: 'audio/mpeg', size: 1000 + n, durationMs: 60_000 }, 'alex', AT);

describe('workspace audio', () => {
  it('adds, sorts, saves, and restores tracks with the workspace snapshot', () => {
    const w = createTestWorkspace('a');
    w.addTrack(track(2));
    w.addTrack(track(1));
    expect(w.getTracks().map(t => t.name)).toEqual(['Track 1.mp3', 'Track 2.mp3']);
    const restored = createWorkspace(w.getSnapshot(), namedRuntime('restored'));
    expect(restored.getTracks()).toEqual(w.getTracks());
    restored.destroy();
  });

  it('keeps the first record for duplicate content and rejects a tombstoned id', () => {
    const w = createTestWorkspace('a');
    const first = track(1);
    w.addTrack(first);
    w.addTrack({ ...first, name: 'Renamed.mp3' });
    expect(w.getTracks()[0].name).toBe('Track 1.mp3');
    w.removeTrack(first.id, 'alex', AT);
    expect(w.getTracks()).toEqual([]);
    expect(() => w.addTrack(first)).toThrow(/removed/i);
  });

  it('merges newer gain, earliest cosmetic record, and tombstones that always win', () => {
    const w = createTestWorkspace('a');
    const base = track(1);
    w.addTrack(base);
    w.mergeAudio([{ ...base, name: 'Renamed.mp3', addedAt: '2026-11-10T11:00:00.000Z', addedBy: 'bea', gain: 150, gainAt: '2026-11-10T12:00:00.000Z', gainBy: 'bea' }], []);
    expect(w.getTracks()[0].name).toBe('Track 1.mp3');
    expect(w.getTracks()[0].gain).toBe(150);
    w.mergeAudio([], [{ id: base.id, at: '2026-11-10T13:00:00.000Z', by: 'bea' }]);
    expect(w.getTracks()).toEqual([]);
    expect(w.getTombstones()).toHaveLength(1);
  });

  it('merges the same records deterministically regardless of order', () => {
    const base = track(1);
    const renamed = { ...base, name: 'Renamed.mp3', gain: 150, gainAt: '2026-11-10T12:00:00.000Z', gainBy: 'bea' };
    const expected = mergeAudioTrack(base, renamed);
    const forward = createTestWorkspace('forward');
    forward.addTrack(base);
    forward.mergeAudio([renamed], []);
    const reverse = createTestWorkspace('reverse');
    reverse.addTrack(renamed);
    reverse.mergeAudio([base], []);
    expect(forward.getTracks()).toEqual(reverse.getTracks());
    expect(forward.getTracks()).toEqual([expected]);
    expect(expected.gain).toBe(150);
    const restoredForward = createWorkspace(forward.getSnapshot(), namedRuntime('restored-forward'));
    const restoredReverse = createWorkspace(reverse.getSnapshot(), namedRuntime('restored-reverse'));
    expect(restoredForward.getTracks()).toEqual(restoredReverse.getTracks());
    expect(restoredForward.getTracks()).toEqual(forward.getTracks());
    restoredForward.destroy();
    restoredReverse.destroy();
  });

  it('persists gain changes and removal, and is idempotent on merge', () => {
    const w = createTestWorkspace('a');
    const t = track(1);
    w.addTrack(t);
    w.setTrackGain(t.id, 175, 'bea', '2026-11-10T11:00:00.000Z');
    expect(w.getTracks()[0].gain).toBe(175);
    const before = w.getSnapshot();
    w.mergeAudio(w.getTracks(), w.getTombstones());
    expect(w.getSnapshot()).toEqual(before);
    w.removeTrack(t.id, 'alex', '2026-11-10T12:00:00.000Z');
    expect(w.getSnapshot()).not.toEqual(before);
    expect(w.getTracks()).toEqual([]);
  });

  it('bounds the number of active tracks and the metadata byte budget', () => {
    const w = createTestWorkspace('a');
    for (let i = 0; i < AUDIO_TRACKS; i++) w.addTrack(track(i));
    expect(() => w.addTrack(track(AUDIO_TRACKS))).toThrow(/limit|track/i);
    const big = createTestWorkspace('big');
    let added = 0;
    expect(() => {
      for (; added < AUDIO_TRACKS; added++) big.addTrack({ ...track(added), name: 'x'.repeat(100) });
    }).toThrow(/limit|metadata/i);
    expect(added).toBeLessThan(AUDIO_TRACKS);
  });

  it('bounds the tombstone set even for ids that are not currently active', () => {
    const w = createTestWorkspace('a');
    for (let i = 0; i < AUDIO_TOMBSTONES; i++) w.mergeAudio([], [{ id: track(i).id, at: AT, by: 'alex' }]);
    expect(() => w.mergeAudio([], [{ id: track(AUDIO_TOMBSTONES).id, at: AT, by: 'alex' }])).toThrow(/limit|tombstone/i);
  });

  it('loads old snapshots without audio maps and rejects invalid durable records', () => {
    const w = createTestWorkspace('a');
    expect(w.getTracks()).toEqual([]);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, w.getSnapshot().history);
    doc.getMap('audio').set('bad', '{"id":"bad"}');
    const snapshot = { game: w.getSnapshot().game, history: Y.encodeStateAsUpdate(doc) };
    expect(() => validateWorkspaceSnapshot(snapshot)).toThrow(/audio/i);
    doc.destroy();
  });
});
