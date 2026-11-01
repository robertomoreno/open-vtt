import { check } from '../game/validation';
import { SIGNALING_URL_LIMIT } from './limits';

// Public STUN discovers network addresses; it never relays gameplay. No TURN.
export const rtcConfiguration: RTCConfiguration = {iceServers:[{urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302']}]};

const defaultSignalingUrls = 'wss://signaling.yjs.dev';

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

export const roomNetworkConfig: { signaling: string[]; rtc: RTCConfiguration } = {
  signaling: parseSignalingUrls(import.meta.env.VITE_SIGNALING_URLS || defaultSignalingUrls),
  rtc: rtcConfiguration,
};
