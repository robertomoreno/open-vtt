import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSignalingUrls, rtcConfiguration, roomNetworkConfig } from '../../src/network/config';

describe('network configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults to the required initial signaling candidate', async () => {
    vi.stubEnv('VITE_GATHER_SIGNALING_URLS', '');
    const config = await import('../../src/network/config');
    expect(config.roomNetworkConfig.signaling).toEqual(['wss://y-webrtc-eu.fly.dev']);
  });

  it('honors the VITE_GATHER_SIGNALING_URLS build-time override', async () => {
    vi.stubEnv('VITE_GATHER_SIGNALING_URLS', 'wss://a.example.test,wss://b.example.test');
    const config = await import('../../src/network/config');
    expect(config.roomNetworkConfig.signaling).toEqual(['wss://a.example.test', 'wss://b.example.test']);
  });

  it('rejects an invalid VITE_GATHER_SIGNALING_URLS override at load time', async () => {
    vi.stubEnv('VITE_GATHER_SIGNALING_URLS', 'ws://insecure.example.test');
    await expect(import('../../src/network/config')).rejects.toThrow();
  });

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
