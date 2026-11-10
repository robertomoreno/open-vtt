import {
  type AudioTrackInput,
  type AudioTransferMeta,
  type AudioType,
  normalizeAudioType,
  sha256Hex,
} from '../game/audio';
import { AUDIO_BYTES, AUDIO_MAX_DURATION_MS } from '../network/limits';

export type PreparedAudio = {
  input: AudioTrackInput;
  bytes: ArrayBuffer;
  meta: AudioTransferMeta;
};

export type PrepareAudioDeps = {
  probeDuration?: (file: File) => Promise<number>;
  canPlay?: (type: string) => boolean;
};

const DURATION_TIMEOUT_MS = 10_000;
const EXTENSION_TYPES: Record<string, AudioType> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
};

const TYPE_MESSAGE = 'Choose a supported audio file: MP3, M4A, AAC, OGG, Opus, WAV, WebM or FLAC.';
const EMPTY_MESSAGE = 'Choose a non-empty audio file.';
const SIZE_MESSAGE = `Choose an audio file no larger than ${megabytes(AUDIO_BYTES)}.`;
const BROWSER_MESSAGE = 'This browser cannot play that audio format.';
const SECURE_MESSAGE = 'Audio files need a secure context (HTTPS or localhost) because this browser cannot hash files.';
const DURATION_MESSAGE = 'This browser could not read that audio file; its duration and encoding may be unsupported.';
const LONG_MESSAGE = `That audio file's duration is too long; choose a file no longer than ${hours(AUDIO_MAX_DURATION_MS)} hours.`;

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function hours(ms: number): number {
  return Math.round(ms / (60 * 60 * 1000));
}

function extensionType(name: string): AudioType | null {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  return EXTENSION_TYPES[lower.slice(dot)] ?? null;
}

export function normalizeAudioFileType(file: File): AudioType | null {
  const fromMime = normalizeAudioType(file.type);
  if (fromMime !== null) return fromMime;
  return typeof file.name === 'string' ? extensionType(file.name) : null;
}

function defaultCanPlay(type: string): boolean {
  if (typeof document === 'undefined') return false;
  const audio = document.createElement('audio');
  return typeof audio.canPlayType === 'function' && audio.canPlayType(type) !== '';
}

async function defaultProbeDuration(file: File): Promise<number> {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error(DURATION_MESSAGE);
  }
  const url = URL.createObjectURL(file);
  const audio = document.createElement('audio');
  try {
    return await new Promise<number>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        audio.removeEventListener('loadedmetadata', onMetadata);
        audio.removeEventListener('error', onError);
        audio.removeAttribute('src');
      };
      const fail = () => {
        cleanup();
        reject(new Error(DURATION_MESSAGE));
      };
      const onMetadata = () => {
        const seconds = audio.duration;
        cleanup();
        if (!Number.isFinite(seconds) || seconds <= 0) {
          reject(new Error(DURATION_MESSAGE));
          return;
        }
        resolve(seconds * 1000);
      };
      const onError = () => fail();
      audio.addEventListener('loadedmetadata', onMetadata);
      audio.addEventListener('error', onError);
      timer = setTimeout(fail, DURATION_TIMEOUT_MS);
      audio.preload = 'metadata';
      audio.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function probeMsOf(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(DURATION_MESSAGE);
  const ms = Math.round(value);
  if (!(ms >= 1)) throw new Error(DURATION_MESSAGE);
  if (ms > AUDIO_MAX_DURATION_MS) throw new Error(LONG_MESSAGE);
  return ms;
}

const READ_MESSAGE = 'This browser could not read that audio file.';

async function readBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  if (typeof FileReader === 'undefined') throw new Error(READ_MESSAGE);
  return await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error(READ_MESSAGE));
    };
    reader.onerror = () => reject(new Error(READ_MESSAGE));
    reader.readAsArrayBuffer(file);
  });
}

export async function prepareAudioFile(file: File, deps: PrepareAudioDeps = {}): Promise<PreparedAudio> {
  if (!(file.size > 0)) throw new Error(EMPTY_MESSAGE);
  if (file.size > AUDIO_BYTES) throw new Error(SIZE_MESSAGE);

  const type = normalizeAudioFileType(file);
  if (type === null) throw new Error(TYPE_MESSAGE);

  const canPlay = deps.canPlay ?? defaultCanPlay;
  if (!canPlay(type)) throw new Error(BROWSER_MESSAGE);

  if (typeof globalThis.crypto?.subtle?.digest !== 'function') throw new Error(SECURE_MESSAGE);

  const bytes = await readBytes(file);
  const id = await sha256Hex(bytes);

  const probe = deps.probeDuration ?? defaultProbeDuration;
  let probedMs: number;
  try {
    probedMs = await probe(file);
  } catch {
    throw new Error(DURATION_MESSAGE);
  }
  const durationMs = probeMsOf(probedMs);

  const name = (file.name || 'audio').slice(0, 100);
  return {
    input: { id, name, type, size: file.size, durationMs },
    bytes,
    meta: { trackId: id, name, type, size: file.size },
  };
}
