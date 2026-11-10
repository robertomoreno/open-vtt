import { check, object } from '../../game/validation';
import {
  NOSTR_DEFAULT_REDUNDANCY,
  NOSTR_RELAY_LIMIT,
  SIGNALING_REDUNDANCY_MIN,
  SIGNALING_URL_LIMIT,
} from '../limits';
import { parseSignalingUrls } from '../config';
import type { SignalingConfig, SignalingProviderId } from './types';

export const SIGNALING_APP_ID = 'gather-v2';
export const DEFAULT_DEV_SIGNALING_URL = 'ws://127.0.0.1:4444';

const DEV_SIGNALING_KEY = 'gather:dev:signaling';
const SIGNALING_FIELDS = ['provider', 'urls', 'redundancy'];

export type LoadSignalingOptions = {
  dev: boolean;
  provider?: string;
  urls?: string;
  redundancy?: string;
  storage?: Pick<Storage, 'getItem'> | null;
};

function providerId(value: unknown): SignalingProviderId {
  check(value === 'wss' || value === 'nostr', 'Choose a signaling provider: wss or nostr.');
  return value;
}

function blankToUndefined(value: unknown): unknown {
  return typeof value === 'string' && !value.trim() ? undefined : value;
}

function hasUrlValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(item => typeof item === 'string' && item.trim().length > 0);
  return false;
}

// Accepts a comma-separated string or a string array; empty values mean "no
// explicit list" so callers fall back to provider defaults.
function parseUrlValue(value: unknown, allowWs: boolean, limit: number): string[] | undefined {
  if (value === undefined) return undefined;
  let raw: string;
  if (typeof value === 'string') {
    raw = value;
  } else if (Array.isArray(value)) {
    check(value.every(item => typeof item === 'string'), 'Signaling URLs must be valid wss:// URLs.');
    const items = (value as string[]).map(item => item.trim()).filter(Boolean);
    if (!items.length) return undefined;
    raw = items.join(',');
  } else {
    throw new Error('Signaling URLs must be valid wss:// URLs.');
  }
  if (!raw.trim()) return undefined;
  return parseSignalingUrls(raw, allowWs, limit);
}

function parseRedundancy(value: unknown): number {
  const count = typeof value === 'string' ? Number(value.trim()) : value;
  check(
    typeof count === 'number'
      && Number.isInteger(count)
      && count >= SIGNALING_REDUNDANCY_MIN
      && count <= NOSTR_RELAY_LIMIT,
    `Signaling redundancy must be an integer from ${SIGNALING_REDUNDANCY_MIN}–${NOSTR_RELAY_LIMIT}.`,
  );
  return count;
}

export function parseSignalingConfig(value: unknown, options: { dev: boolean }): SignalingConfig {
  const raw = object(value, SIGNALING_FIELDS);
  const explicit = blankToUndefined(raw.provider);
  const urls = hasUrlValue(raw.urls);
  const provider = explicit === undefined
    ? (urls || options.dev ? 'wss' : 'nostr')
    : providerId(explicit);
  const limit = provider === 'wss' ? SIGNALING_URL_LIMIT : NOSTR_RELAY_LIMIT;
  const list = parseUrlValue(raw.urls, options.dev, limit);
  const redundancy = blankToUndefined(raw.redundancy);

  if (provider === 'wss') {
    check(redundancy === undefined, 'Signaling redundancy is only valid for the nostr provider.');
    const configured = list ?? (options.dev ? [DEFAULT_DEV_SIGNALING_URL] : undefined);
    check(configured !== undefined, `Configure 1–${SIGNALING_URL_LIMIT} signaling URLs.`);
    return { provider: 'wss', urls: configured };
  }

  const count = parseRedundancy(redundancy ?? NOSTR_DEFAULT_REDUNDANCY);
  return list === undefined
    ? { provider: 'nostr', redundancy: count }
    : { provider: 'nostr', urls: list, redundancy: count };
}

export function readDevSignalingOverride(storage: Pick<Storage, 'getItem'> | null | undefined): unknown {
  if (!storage) return undefined;
  let raw: string | null;
  try {
    raw = storage.getItem(DEV_SIGNALING_KEY);
  } catch {
    return undefined;
  }
  if (raw === null || !raw.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Not JSON: treat it as the legacy comma-separated WSS URL string.
  }
  return raw;
}

export function loadSignalingConfig(options: LoadSignalingOptions): SignalingConfig {
  if (options.dev) {
    const override = readDevSignalingOverride(options.storage ?? null);
    if (override !== undefined) {
      return parseSignalingConfig(
        typeof override === 'string' ? { provider: 'wss', urls: override } : override,
        { dev: true },
      );
    }
  }
  const provider = blankToUndefined(options.provider);
  const urls = blankToUndefined(options.urls);
  const redundancy = blankToUndefined(options.redundancy);
  return parseSignalingConfig({
    ...(provider === undefined ? {} : { provider }),
    ...(urls === undefined ? {} : { urls }),
    ...(redundancy === undefined ? {} : { redundancy }),
  }, { dev: options.dev });
}

function devStorage(): Pick<Storage, 'getItem'> | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

// Resolved once at module load. Invalid configuration throws here rather than
// silently falling back to a different provider. Endpoints are never logged.
export const signalingConfig: SignalingConfig = loadSignalingConfig({
  dev: import.meta.env.DEV,
  provider: import.meta.env.VITE_GATHER_SIGNALING_PROVIDER,
  urls: import.meta.env.VITE_GATHER_SIGNALING_URLS,
  redundancy: import.meta.env.VITE_GATHER_SIGNALING_REDUNDANCY,
  storage: import.meta.env.DEV ? devStorage() : null,
});
