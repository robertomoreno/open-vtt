import { check } from '../game/validation';
import { SIGNALING_URL_LIMIT } from './limits';

// Public STUN discovers network addresses; it never relays gameplay. No TURN.
export const rtcConfiguration: RTCConfiguration = {iceServers:[{urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302']}]};

const defaultSignalingUrls = 'wss://y-webrtc-eu.fly.dev';

export function parseSignalingUrls(input: string): string[] {
  const urls = input.split(',').map(url => url.trim()).filter(Boolean);
  check(urls.length >= 1 && urls.length <= SIGNALING_URL_LIMIT, `Configure 1–${SIGNALING_URL_LIMIT} signaling URLs.`);
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Signaling URLs must be valid wss:// URLs.');
    }
    check(parsed.protocol === 'wss:' && parsed.host.length > 0, 'Signaling URLs must be valid wss:// URLs.');
  }
  return urls;
}

// Dev-only override: allows pointing the app at a local ws:// relay (e.g. the
// loopback signaling server started with `npm run signal:start`) without a TLS
// endpoint. Production builds never honor this — import.meta.env.DEV is false
// there, so Vite removes the branch entirely. Never accept an endpoint from a
// room link; this override is read only from the developer's own browser storage.
function devSignalingOverride(): string[] | null {
  if (!import.meta.env.DEV) return null;
  let raw: string | null = null;
  try { raw = window.localStorage.getItem('gather:dev:signaling'); } catch {}
  if (!raw) return null;
  const urls = raw.split(',').map(u => u.trim()).filter(Boolean);
  if (urls.length < 1 || urls.length > SIGNALING_URL_LIMIT) return null;
  for (const url of urls) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if ((parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') || parsed.host.length === 0) return null;
  }
  return urls;
}

const devOverride = devSignalingOverride();
if (import.meta.env.DEV && devOverride) {
  // eslint-disable-next-line no-console
  console.info('[Gather dev] Using signaling override from localStorage "gather:dev:signaling":', devOverride.join(', '));
}
const signalingUrls = devOverride ?? parseSignalingUrls(import.meta.env.VITE_GATHER_SIGNALING_URLS || defaultSignalingUrls);

export const roomNetworkConfig: { signaling: string[]; rtc: RTCConfiguration } = {
  signaling: signalingUrls,
  rtc: rtcConfiguration,
};
