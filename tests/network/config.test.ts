import { describe, expect, it } from 'vitest';
import { parseSignalingUrls, rtcConfiguration, roomNetworkConfig } from '../../src/network/config';

describe('network configuration', () => {
  it('uses explicit STUN-only ICE', () => {
    const urls = roomNetworkConfig.rtc.iceServers?.flatMap(server => server.urls) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url.startsWith('stun:')).toBe(true);
    for (const url of roomNetworkConfig.signaling) expect(url.startsWith('wss://')).toBe(true);
    expect(rtcConfiguration.iceServers?.flatMap(server => server.urls)).toEqual(urls);
  });

  it('accepts a comma-separated list of wss signaling endpoints', () => {
    expect(parseSignalingUrls('wss://a.example.test, wss://b.example.test')).toEqual([
      'wss://a.example.test',
      'wss://b.example.test',
    ]);
  });

  it('rejects non-wss, empty, and oversized signaling lists', () => {
    expect(() => parseSignalingUrls('ws://a.example.test')).toThrow();
    expect(() => parseSignalingUrls('https://a.example.test')).toThrow();
    expect(() => parseSignalingUrls('')).toThrow();
    expect(() => parseSignalingUrls('wss://1.test,wss://2.test,wss://3.test,wss://4.test,wss://5.test')).toThrow();
  });
});
