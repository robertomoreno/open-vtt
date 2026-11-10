import { AUDIO_TRANSFER_BYTES } from '../../limits';
import { SIGNALING_APP_ID } from '../config';
import type { SignalingConfig, SignalingPlan } from '../types';

export async function createNostrPlan(
  config: Extract<SignalingConfig, { provider: 'nostr' }>,
  options: { dev: boolean },
): Promise<SignalingPlan> {
  const { joinRoom } = await import('@trystero-p2p/nostr');
  return {
    id: 'nostr',
    join: joinRoom,
    base: { appId: SIGNALING_APP_ID, maxReceiveBytes: AUDIO_TRANSFER_BYTES },
    relayConfig: {
      ...(config.urls?.length ? { urls: config.urls } : {}),
      redundancy: config.redundancy,
      warnOnRelayFailure: options.dev,
    },
    allowsLoopbackCandidateFallback: false,
  };
}
