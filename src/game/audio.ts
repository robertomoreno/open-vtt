import { AUDIO_BYTES, AUDIO_MAX_DURATION_MS } from '../network/limits';
import { check, id, object, text, timestamp } from './validation';

export const AUDIO_TYPES = [
  'audio/aac', 'audio/flac', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
] as const;
export type AudioType = (typeof AUDIO_TYPES)[number];

export type AudioTrack = {
  id: string;
  name: string;
  type: AudioType;
  size: number;
  durationMs: number;
  addedBy: string;
  addedAt: string;
  gain: number;
  gainAt: string;
  gainBy: string;
};
export type AudioTombstone = { id: string; at: string; by: string };
export type AudioTrackInput = { id: string; name: string; type: AudioType; size: number; durationMs: number };
export type AudioTransferMeta = { trackId: string; name: string; type: AudioType; size: number };
export type AudioPositionBody = { trackId: string; playing: boolean; positionMs: number };
export type AudioPosition = AudioPositionBody & { rev: number };
export type PlaybackCommand = AudioPosition & { id: string; participantId: string; at: string };

const AUDIO_ID = /^[0-9a-f]{64}$/;
const TYPE_ALIASES: Record<string, AudioType> = {
  'audio/mp3': 'audio/mpeg',
  'audio/mpeg3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/wave': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/m4a': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4',
  'audio/x-flac': 'audio/flac',
  'audio/x-aac': 'audio/aac',
};
const GAIN_MAX = 200;
const encoder = new TextEncoder();

function audioId(value: unknown): string {
  check(typeof value === 'string' && AUDIO_ID.test(value), 'Invalid audio ID.');
  return value;
}

function audioType(value: unknown): AudioType {
  check(typeof value === 'string' && (AUDIO_TYPES as readonly string[]).includes(value), 'Unsupported audio type.');
  return value as AudioType;
}

function audioName(value: unknown): string {
  check(typeof value === 'string', 'Invalid audio name.');
  return text(value, 100);
}

function audioSize(value: unknown): number {
  check(Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= AUDIO_BYTES, 'Invalid audio size.');
  return value as number;
}

function audioDuration(value: unknown): number {
  check(Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= AUDIO_MAX_DURATION_MS, 'Invalid audio duration.');
  return value as number;
}

function audioGain(value: unknown): number {
  check(Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= GAIN_MAX, 'Invalid audio gain.');
  return value as number;
}

function audioPosition(value: unknown): number {
  check(Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= AUDIO_MAX_DURATION_MS, 'Invalid audio position.');
  return value as number;
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

export function validateAudioTrack(value: unknown): AudioTrack {
  const track = object(value, ['id', 'name', 'type', 'size', 'durationMs', 'addedBy', 'addedAt', 'gain', 'gainAt', 'gainBy']);
  return {
    id: audioId(track.id),
    name: audioName(track.name),
    type: audioType(track.type),
    size: audioSize(track.size),
    durationMs: audioDuration(track.durationMs),
    addedBy: id(track.addedBy),
    addedAt: timestamp(track.addedAt),
    gain: audioGain(track.gain),
    gainAt: timestamp(track.gainAt),
    gainBy: id(track.gainBy),
  };
}

export function validateAudioTombstone(value: unknown): AudioTombstone {
  const tombstone = object(value, ['id', 'at', 'by']);
  return { id: audioId(tombstone.id), at: timestamp(tombstone.at), by: id(tombstone.by) };
}

export function validateAudioTransferMeta(value: unknown): AudioTransferMeta {
  const meta = object(value, ['trackId', 'name', 'type', 'size']);
  return { trackId: audioId(meta.trackId), name: audioName(meta.name), type: audioType(meta.type), size: audioSize(meta.size) };
}

export function validatePlaybackCommand(value: unknown): PlaybackCommand {
  const command = object(value, ['id', 'rev', 'participantId', 'trackId', 'playing', 'positionMs', 'at']);
  check(Number.isSafeInteger(command.rev) && (command.rev as number) >= 0, 'Invalid playback revision.');
  check(typeof command.playing === 'boolean', 'Invalid playback state.');
  return {
    id: id(command.id),
    rev: command.rev as number,
    participantId: id(command.participantId),
    trackId: audioId(command.trackId),
    playing: command.playing,
    positionMs: audioPosition(command.positionMs),
    at: timestamp(command.at),
  };
}

function normalizeTypeName(value: string): string {
  return value.trim().toLowerCase().split(';')[0].trim();
}

export function normalizeAudioType(value: string): AudioType | null {
  if (typeof value !== 'string') return null;
  const name = normalizeTypeName(value);
  if ((AUDIO_TYPES as readonly string[]).includes(name)) return name as AudioType;
  return TYPE_ALIASES[name] ?? null;
}

export function createAudioTrack(input: AudioTrackInput, playerId: string, at: string): AudioTrack {
  const player = id(playerId), addedAt = timestamp(at);
  return validateAudioTrack({
    id: input.id,
    name: input.name,
    type: input.type,
    size: input.size,
    durationMs: input.durationMs,
    addedBy: player,
    addedAt,
    gain: 100,
    gainAt: addedAt,
    gainBy: player,
  });
}

export function compareAudioTracks(a: AudioTrack, b: AudioTrack): number {
  const an = a.name.toLowerCase(), bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function earlierAdd(a: AudioTrack, b: AudioTrack): AudioTrack {
  if (a.addedAt !== b.addedAt) return a.addedAt < b.addedAt ? a : b;
  if (a.addedBy !== b.addedBy) return a.addedBy < b.addedBy ? a : b;
  return canonical(a) <= canonical(b) ? a : b;
}

function newerGain(a: AudioTrack, b: AudioTrack): AudioTrack {
  if (a.gainAt !== b.gainAt) return a.gainAt > b.gainAt ? a : b;
  if (a.gainBy !== b.gainBy) return a.gainBy > b.gainBy ? a : b;
  return canonical(a) >= canonical(b) ? a : b;
}

export function mergeAudioTrack(existing: AudioTrack, incoming: AudioTrack): AudioTrack {
  const cosmetic = earlierAdd(existing, incoming), gain = newerGain(existing, incoming);
  return { ...cosmetic, gain: gain.gain, gainAt: gain.gainAt, gainBy: gain.gainBy };
}

export function mergeAudioTombstone(a: AudioTombstone, b: AudioTombstone): AudioTombstone {
  check(a.id === b.id, 'Cannot merge different audio tombstones.');
  if (a.at !== b.at) return a.at < b.at ? a : b;
  if (a.by !== b.by) return a.by < b.by ? a : b;
  return canonical(a) <= canonical(b) ? a : b;
}

export function comparePlaybackCommands(a: PlaybackCommand, b: PlaybackCommand): number {
  if (a.rev !== b.rev) return a.rev - b.rev;
  if (a.participantId !== b.participantId) return a.participantId < b.participantId ? -1 : 1;
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function latestPlaybackCommand(commands: readonly PlaybackCommand[]): PlaybackCommand | null {
  let latest: PlaybackCommand | null = null;
  for (const command of commands) {
    if (latest === null || comparePlaybackCommands(command, latest) > 0) latest = command;
  }
  return latest;
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(source));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function audioTrackBytes(track: AudioTrack): number {
  return encoder.encode(JSON.stringify(track)).byteLength;
}
