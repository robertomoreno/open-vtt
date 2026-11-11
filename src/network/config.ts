import { check } from '../game/validation';
import { SIGNALING_URL_LIMIT } from './limits';

// Public STUN discovers network addresses; it never relays gameplay. No TURN.
export const rtcConfiguration: RTCConfiguration = {iceServers:[{urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302']}]};

export function parseSignalingUrls(input: string, allowWs = false, limit = SIGNALING_URL_LIMIT): string[] {
  const urls = input.split(',').map(url => url.trim()).filter(Boolean);
  check(urls.length >= 1 && urls.length <= limit, `Configure 1–${limit} signaling URLs.`);
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Signaling URLs must be valid wss:// URLs.');
    }
    check(!parsed.username && !parsed.password, 'Signaling URLs must not contain credentials.');
    const ok = parsed.host.length > 0 && (parsed.protocol === 'wss:' || (allowWs && parsed.protocol === 'ws:'));
    check(ok, 'Signaling URLs must be valid wss:// URLs.');
    check(!parsed.search && !parsed.hash, 'Signaling URLs must be valid wss:// URLs.');
  }
  return urls;
}

// Browsers obfuscate local addresses in ICE candidates as mDNS hostnames
// (e.g. "4f3a....local"). Some macOS/browser configurations cannot resolve
// those cross-process, so same-machine peers exchange only unusable mDNS and
// public STUN candidates and ICE fails. When every signaling URL is loopback,
// all participants must be on this machine, so rewriting host candidates to
// 127.0.0.1 is exact. The resolved signaling plan decides whether that rewrite
// applies; this predicate only classifies a single endpoint. Independently of
// signaling, the RTC runtime also tries each incoming mDNS host on 127.0.0.1
// while retaining the original candidate, so same-machine peers work through
// public signaling without assuming that every peer is local.
export function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/g, '');
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}
