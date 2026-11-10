import { describe, expect, it } from 'vitest';
import { isLoopbackUrl, parseSignalingUrls, rtcConfiguration } from '../../src/network/config';

describe('network configuration', () => {
  it('uses explicit STUN-only ICE', () => {
    const urls = rtcConfiguration.iceServers?.flatMap(server => server.urls) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url.startsWith('stun:')).toBe(true);
  });

  it('accepts up to the provider limit of secure signaling URLs', () => {
    expect(parseSignalingUrls('wss://a.example, wss://b.example')).toEqual([
      'wss://a.example',
      'wss://b.example',
    ]);
  });

  it('rejects non-wss, empty, oversized, and credential-bearing lists', () => {
    expect(() => parseSignalingUrls('ws://a.example')).toThrow();
    expect(() => parseSignalingUrls('https://a.example')).toThrow();
    expect(() => parseSignalingUrls('')).toThrow();
    expect(() => parseSignalingUrls('wss://a.example,wss://b.example,wss://c.example,wss://d.example,wss://e.example')).toThrow();
    expect(() => parseSignalingUrls('wss://user:pass@a.example')).toThrow(/credentials/i);
    expect(() => parseSignalingUrls('wss://a.example/#fragment')).toThrow(/URL/i);
  });

  it('recognizes loopback hosts', () => {
    expect(isLoopbackUrl('ws://127.0.0.1:4444')).toBe(true);
    expect(isLoopbackUrl('ws://localhost:4444')).toBe(true);
    expect(isLoopbackUrl('ws://[::1]:4444')).toBe(true);
    expect(isLoopbackUrl('wss://relay.example')).toBe(false);
  });
});
