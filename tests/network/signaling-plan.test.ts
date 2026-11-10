import { describe, expect, it } from 'vitest';
import { resolveSignalingPlan } from '../../src/network/signaling/resolve';

describe('signaling plans', () => {
  it('builds a loopback WSS plan with the exact shared config', async () => {
    const plan = await resolveSignalingPlan(
      { provider: 'wss', urls: ['ws://127.0.0.1:4444'] },
      { dev: true },
    );
    expect(plan.id).toBe('wss');
    expect(plan.base).toEqual({ appId: 'gather-v2', maxReceiveBytes: 12 * 1024 * 1024 });
    expect(plan.relayConfig).toEqual({ urls: ['ws://127.0.0.1:4444'] });
    expect(plan.allowsLoopbackCandidateFallback).toBe(true);
    expect(typeof plan.join).toBe('function');
  });

  it('does not allow the loopback candidate rewrite for an empty URL list', async () => {
    const plan = await resolveSignalingPlan(
      { provider: 'wss', urls: [] },
      { dev: true },
    );
    expect(plan.allowsLoopbackCandidateFallback).toBe(false);
  });

  it('does not allow the loopback candidate rewrite for a remote URL', async () => {
    const plan = await resolveSignalingPlan(
      { provider: 'wss', urls: ['wss://relay.example'] },
      { dev: true },
    );
    expect(plan.allowsLoopbackCandidateFallback).toBe(false);
  });
});
