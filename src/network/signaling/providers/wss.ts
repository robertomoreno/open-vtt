import { isLoopbackUrl } from '../../config';
import { AUDIO_TRANSFER_BYTES } from '../../limits';
import { SIGNALING_APP_ID } from '../config';
import type { SignalingConfig, SignalingPlan } from '../types';

export async function createWssPlan(
  config: Extract<SignalingConfig, { provider: 'wss' }>,
  options: { dev: boolean },
): Promise<SignalingPlan> {
  const { createGatherSignalingStrategy } = await import('../../trystero-signaling');
  return {
    id: 'wss',
    join: createGatherSignalingStrategy(),
    base: { appId: SIGNALING_APP_ID, maxReceiveBytes: AUDIO_TRANSFER_BYTES },
    relayConfig: { urls: config.urls },
    allowsLoopbackCandidateFallback:
      options.dev && config.urls.length > 0 && config.urls.every(isLoopbackUrl),
  };
}
