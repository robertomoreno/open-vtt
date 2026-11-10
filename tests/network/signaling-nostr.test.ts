import { beforeEach, describe, expect, it, vi } from 'vitest';

const { joinRoom } = vi.hoisted(() => ({ joinRoom: vi.fn() }));
vi.mock('@trystero-p2p/nostr', () => ({ joinRoom }));

import { resolveSignalingPlan } from '../../src/network/signaling/resolve';

describe('Nostr signaling plan', () => {
  beforeEach(() => joinRoom.mockReset());

  it('builds the production default with redundancy 8', async () => {
    const plan = await resolveSignalingPlan(
      { provider: 'nostr', redundancy: 8 },
      { dev: false },
    );
    expect(plan.id).toBe('nostr');
    expect(plan.join).toBe(joinRoom);
    expect(plan.base).toEqual({ appId: 'gather-v2', maxReceiveBytes: 12 * 1024 * 1024 });
    expect(plan.relayConfig).toEqual({ redundancy: 8, warnOnRelayFailure: false });
    expect(plan.allowsLoopbackCandidateFallback).toBe(false);
  });

  it('omits an empty URL list so the default relays stay in effect', async () => {
    const plan = await resolveSignalingPlan(
      { provider: 'nostr', urls: [], redundancy: 8 },
      { dev: false },
    );
    expect(plan.relayConfig).toStrictEqual({ redundancy: 8, warnOnRelayFailure: false });
    expect(plan.relayConfig).not.toHaveProperty('urls');
  });

  it('uses explicit relays and warns in development', async () => {
    const plan = await resolveSignalingPlan(
      { provider: 'nostr', urls: ['wss://a.example'], redundancy: 8 },
      { dev: true },
    );
    expect(plan.relayConfig).toEqual({
      urls: ['wss://a.example'],
      redundancy: 8,
      warnOnRelayFailure: true,
    });
    expect(plan.allowsLoopbackCandidateFallback).toBe(false);
  });
});
