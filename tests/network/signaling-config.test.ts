import { describe, expect, it } from 'vitest';
import { loadSignalingConfig, parseSignalingConfig } from '../../src/network/signaling/config';

const dev = { dev: true } as const;
const prod = { dev: false } as const;
const memory = (value: string | null) => ({ getItem: (_key: string) => value });

describe('signaling configuration', () => {
  it('defaults development to the loopback WSS relay', () => {
    expect(loadSignalingConfig(dev)).toEqual({
      provider: 'wss',
      urls: ['ws://127.0.0.1:4444'],
    });
  });

  it('defaults production to Nostr with redundancy 8', () => {
    expect(loadSignalingConfig(prod)).toEqual({ provider: 'nostr', redundancy: 8 });
  });

  it('treats a URL-only production override as WSS for compatibility', () => {
    expect(loadSignalingConfig({ ...prod, urls: 'wss://relay.example' })).toEqual({
      provider: 'wss',
      urls: ['wss://relay.example'],
    });
  });

  it('parses explicit Nostr URLs and redundancy', () => {
    expect(loadSignalingConfig({
      ...prod,
      provider: 'nostr',
      urls: 'wss://a.example,wss://b.example',
      redundancy: '3',
    })).toEqual({
      provider: 'nostr',
      urls: ['wss://a.example', 'wss://b.example'],
      redundancy: 3,
    });
  });

  it('rejects invalid providers, schemes, credentials, counts, and redundancy', () => {
    expect(() => parseSignalingConfig({ provider: 'mqtt' }, prod)).toThrow(/provider/i);
    expect(() => parseSignalingConfig({ provider: 'wss', urls: 'https://x.example' }, prod)).toThrow(/wss/i);
    expect(() => parseSignalingConfig({ provider: 'wss', urls: 'wss://u:p@x.example' }, prod)).toThrow(/credentials/i);
    expect(() => parseSignalingConfig({ provider: 'wss' }, prod)).toThrow(/URL/i);
    expect(() => parseSignalingConfig({ provider: 'nostr', redundancy: 0 }, prod)).toThrow(/redundancy/i);
    expect(() => parseSignalingConfig({ provider: 'nostr', redundancy: 9 }, prod)).toThrow(/redundancy/i);
    expect(() => parseSignalingConfig({ provider: 'wss', urls: Array(5).fill('wss://x.example') }, prod)).toThrow(/1–4/);
    expect(() => parseSignalingConfig({ provider: 'nostr', urls: Array(9).fill('wss://x.example') }, prod)).toThrow(/1–8/);
    expect(() => parseSignalingConfig({ provider: 'nostr', extra: true }, prod)).toThrow(/Unexpected fields/i);
  });

  it('reads development JSON and legacy CSV overrides, but production ignores storage', () => {
    const json = JSON.stringify({ provider: 'nostr', redundancy: 4 });
    expect(loadSignalingConfig({ ...dev, storage: memory(json) })).toEqual({
      provider: 'nostr',
      redundancy: 4,
    });
    expect(loadSignalingConfig({ ...dev, storage: memory('ws://127.0.0.1:5555') })).toEqual({
      provider: 'wss',
      urls: ['ws://127.0.0.1:5555'],
    });
    expect(loadSignalingConfig({ ...prod, storage: memory(json) })).toEqual({
      provider: 'nostr',
      redundancy: 8,
    });
  });

  it('rejects fragments and query strings in signaling URLs', () => {
    expect(() => parseSignalingConfig({ provider: 'wss', urls: 'wss://x.example/#frag' }, prod)).toThrow(/URL/i);
    expect(() => parseSignalingConfig({ provider: 'wss', urls: 'wss://x.example/?a=1' }, prod)).toThrow(/URL/i);
  });
});
