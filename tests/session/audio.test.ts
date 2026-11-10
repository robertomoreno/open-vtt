import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createAudioTrack } from '../../src/game/audio';
import { createTestWorkspace } from '../helpers/workspace';
import { createAudioSession } from '../../src/session/audio';
import { STAGE_AUDIO, STAGE_AUDIO_PLAYBACK, STAGE_AUDIO_TOMBSTONES } from '../../src/session/workspace-bridge';
import type { RoomTransport } from '../../src/network/room';

const AT = '2026-11-10T10:00:00.000Z';
const track = (n = 1) => createAudioTrack({ id: `${'a'.repeat(60)}${String(n).padStart(4, '0')}`, name: `Theme ${n}.mp3`, type: 'audio/mpeg', size: 1000, durationMs: 60_000 }, 'alex', AT);

function setup(clock = { at: 0 }) {
  const stage = new Y.Doc();
  const workspace = createTestWorkspace('a');
  const errors: string[] = [];
  const audio = createAudioSession({ stage, workspace, now: () => clock.at, runtime: { id: () => 'id', now: () => AT, die: () => 1 }, onError: m => errors.push(m), onDirty: () => {} });
  return { stage, workspace, audio, clock, errors };
}
const transport = (overrides: Partial<RoomTransport['audio']> = {}): RoomTransport => ({
  getView: () => ({ phase: 'connected', openRtcConnections: 1, presence: [{ id: 'a-1', seenAt: 0 }], error: null }),
  subscribe: () => () => {}, close() {},
  audio: { setHandlers() {}, sendTrack: async () => {}, requestHolders: async () => [], requestFetch: async () => false, requestPosition: async () => null, ...overrides },
});

describe('session audio', () => {
  it('adds a track as the seated player and persists it in the workspace', () => {
    const { audio, workspace } = setup();
    audio.setLocalPlayerId('alex');
    audio.addTrack({ id: track().id, name: 'Theme 1.mp3', type: 'audio/mpeg', size: 1000, durationMs: 60_000 });
    expect(audio.getView().tracks.map(t => t.name)).toEqual(['Theme 1.mp3']);
    expect(workspace.getTracks()).toHaveLength(1);
  });

  it('merges staged metadata and tombstones and re-publishes the shared library', () => {
    const { audio, stage } = setup();
    const t = track();
    stage.transact(() => stage.getMap(STAGE_AUDIO).set(t.id, JSON.stringify(t)));
    audio.sync();
    expect(audio.getView().tracks).toHaveLength(1);
    stage.transact(() => stage.getMap(STAGE_AUDIO_TOMBSTONES).set(t.id, JSON.stringify({ id: t.id, at: AT, by: 'bea' })));
    audio.sync();
    expect(audio.getView().tracks).toEqual([]);
    expect(audio.getView().tombstones).toEqual([t.id]);
  });

  it('writes select/play/stop/seek commands with increasing revisions and a start lead', () => {
    const { audio, stage, clock } = setup();
    audio.setLocalPlayerId('alex');
    audio.addTrack({ id: track().id, name: 'Theme.mp3', type: 'audio/mpeg', size: 1000, durationMs: 60_000 });
    audio.setTransport(transport());
    audio.selectTrack(track().id);
    expect(audio.getView().playing).toBe(false);
    expect(audio.getView().positionMs).toBe(0);
    audio.playTrack();
    expect(audio.getView().playing).toBe(true);
    expect(audio.getView().startedAt).toBe(clock.at + 500);
    audio.seekTrack(10_000);
    expect(audio.getView().positionMs).toBe(10_000);
    audio.stopTrack();
    expect(audio.getView().playing).toBe(false);
    const commands = [...stage.getArray(STAGE_AUDIO_PLAYBACK)].map(v => JSON.parse(v as string));
    expect(commands.map(c => c.rev)).toEqual([1, 2, 3, 4]);
  });

  it('applies only the highest revision and resolves concurrent ties by participant id', () => {
    const { audio, stage } = setup();
    const t = track();
    audio.setLocalPlayerId('alex');
    audio.addTrack({ id: t.id, name: t.name, type: 'audio/mpeg', size: 1000, durationMs: 60_000 });
    const command = (rev: number, participantId: string, playing: boolean) => ({ id: `c${rev}${participantId}`, rev, participantId, trackId: t.id, playing, positionMs: 0, at: AT });
    stage.transact(() => {
      stage.getArray(STAGE_AUDIO_PLAYBACK).push([JSON.stringify(command(2, 'z', true)), JSON.stringify(command(2, 'a', false))]);
    });
    audio.setTransport(transport());
    audio.sync();
    // Equal revisions resolve by the higher participant id, so 'z' (playing) wins.
    expect(audio.getView().playing).toBe(true);
  });

  it('requires a live connection for transport controls but allows library edits offline', () => {
    const { audio, errors } = setup();
    audio.setLocalPlayerId('alex');
    audio.addTrack({ id: track().id, name: 'Theme.mp3', type: 'audio/mpeg', size: 1000, durationMs: 60_000 });
    audio.selectTrack(track().id);
    expect(errors.at(-1)).toMatch(/connection/i);
    audio.playTrack();
    expect(errors.at(-1)).toMatch(/connection/i);
    expect(audio.getView().tracks).toHaveLength(1);
  });

  it('requests the current position on a late join and applies half the round trip', async () => {
    const { audio, stage, clock } = setup();
    const t = track();
    audio.setLocalPlayerId('alex');
    audio.addTrack({ id: t.id, name: t.name, type: 'audio/mpeg', size: 1000, durationMs: 60_000 });
    stage.transact(() => stage.getArray(STAGE_AUDIO_PLAYBACK).push([JSON.stringify({ id: 'c1', rev: 1, participantId: 'bea', trackId: t.id, playing: true, positionMs: 1000, at: AT })]));
    const requestPosition = vi.fn(async () => ({ peerId: 'bea', position: { trackId: t.id, playing: true, positionMs: 5000 }, rttMs: 200 }));
    audio.setTransport(transport({ requestPosition }));
    audio.sync();
    await vi.waitFor(() => expect(requestPosition).toHaveBeenCalled());
    await vi.waitFor(() => expect(audio.getView().resyncPending).toBe(false));
    expect(audio.getView().positionMs).toBe(5100);
    expect(audio.getView().startedAt).toBe(clock.at + 500);
  });

  it('falls back to the command timestamp and labels it approximate when nobody answers', async () => {
    const clock = { at: 20_000 };
    const { audio, stage } = setup(clock);
    const t = track();
    audio.setLocalPlayerId('alex');
    audio.addTrack({ id: t.id, name: t.name, type: 'audio/mpeg', size: 1000, durationMs: 60_000 });
    stage.transact(() => stage.getArray(STAGE_AUDIO_PLAYBACK).push([JSON.stringify({ id: 'c1', rev: 1, participantId: 'bea', trackId: t.id, playing: true, positionMs: 1000, at: new Date(10_000).toISOString() })]));
    audio.setTransport(transport({ requestPosition: async () => null }));
    audio.sync();
    await vi.waitFor(() => expect(audio.getView().resyncPending).toBe(false));
    expect(audio.getView().positionMs).toBe(11_000);
    expect(audio.getView().approximate).toBe(true);
    expect(audio.getView().startedAt).toBe(clock.at + 500);
  });

  it('delegates transfer handlers and clears them when the transport is removed', async () => {
    const { audio } = setup();
    const onTrack = vi.fn();
    audio.onAudioTrack(onTrack);
    const handlers: any[] = [];
    const fake = transport();
    fake.audio.setHandlers = h => { handlers.push(h); };
    audio.setTransport(fake);
    handlers.at(-1).onTrack(new Uint8Array([1]), { trackId: track().id, name: 'x', type: 'audio/mpeg', size: 1 }, 'peer-a');
    expect(onTrack).toHaveBeenCalledTimes(1);
    audio.setTransport(null);
    expect(audio.getView().connected).toBe(false);
  });
});
