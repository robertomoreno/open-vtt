import { check } from '../game/validation';
import { SIGNALING_URL_LIMIT } from './limits';

// Public STUN discovers network addresses; it never relays gameplay. No TURN.
export const rtcConfiguration: RTCConfiguration = {iceServers:[{urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302']}]};

const defaultSignalingUrls = 'wss://y-webrtc-eu.fly.dev';

export function parseSignalingUrls(input: string, allowWs = false): string[] {
  const urls = input.split(',').map(url => url.trim()).filter(Boolean);
  check(urls.length >= 1 && urls.length <= SIGNALING_URL_LIMIT, `Configure 1–${SIGNALING_URL_LIMIT} signaling URLs.`);
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Signaling URLs must be valid wss:// URLs.');
    }
    const ok = parsed.host.length > 0 && (parsed.protocol === 'wss:' || (allowWs && parsed.protocol === 'ws:'));
    check(ok, 'Signaling URLs must be valid wss:// URLs.');
  }
  return urls;
}

// Dev-only override: allows pointing the app at a local ws:// relay (e.g. the
// loopback signaling server started with `npm run signal:start`) without a TLS
// endpoint. Production builds never honor this — import.meta.env.DEV is false
// there, so Vite removes the branch entirely. Never accept an endpoint from a
// room link; this override is read only from the developer's own browser storage
// or the VITE_GATHER_SIGNALING_URLS env var at dev time.
function devSignalingOverride(): string[] | null {
  if (!import.meta.env.DEV) return null;
  // 1. Env var at dev time (cleanest: VITE_GATHER_SIGNALING_URLS=ws://127.0.0.1:4444 npm run dev)
  const env = import.meta.env.VITE_GATHER_SIGNALING_URLS;
  if (env) {
    try { return parseSignalingUrls(env, true); } catch { return null; }
  }
  // 2. localStorage override (set once, persists across reloads)
  let raw: string | null = null;
  try { raw = window.localStorage.getItem('gather:dev:signaling'); } catch {}
  if (!raw) return null;
  try { return parseSignalingUrls(raw, true); } catch { return null; }
}

const devOverride = devSignalingOverride();
const signalingUrls = devOverride ?? parseSignalingUrls(import.meta.env.VITE_GATHER_SIGNALING_URLS || defaultSignalingUrls);
if (import.meta.env.DEV) {
  // eslint-disable-next-line no-console
  console.info('[Gather dev] Resolved signaling URLs:', signalingUrls.join(', '));
  if (devOverride) {
    // eslint-disable-next-line no-console
    console.info('[Gather dev] (override active)');
  }
}

// Browsers obfuscate local addresses in ICE candidates as mDNS hostnames
// (e.g. "4f3a....local"). Some macOS/browser configurations cannot resolve
// those cross-process, so same-machine peers exchange only unusable mDNS and
// public STUN candidates and ICE fails. When every signaling URL is loopback,
// all participants must be on this machine, so rewriting host candidates to
// 127.0.0.1 is exact. This is dev-only; a production build never enables it.
function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/g, '');
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}
export const signalingIsLoopback = import.meta.env.DEV && signalingUrls.every(isLoopbackUrl);
if (signalingIsLoopback) {
  // eslint-disable-next-line no-console
  console.info('[Gather dev] Loopback signaling: rewriting mDNS host candidates to 127.0.0.1 for same-machine peers.');
}

export const roomNetworkConfig: { signaling: string[]; rtc: RTCConfiguration } = {
  signaling: signalingUrls,
  rtc: rtcConfiguration,
};
