import { createNostrPlan } from './providers/nostr';
import { createWssPlan } from './providers/wss';
import type { SignalingConfig, SignalingPlan } from './types';

export async function resolveSignalingPlan(
  config: SignalingConfig,
  options: { dev?: boolean } = {},
): Promise<SignalingPlan> {
  const dev = options.dev ?? import.meta.env.DEV;
  return config.provider === 'wss'
    ? createWssPlan(config, { dev })
    : createNostrPlan(config, { dev });
}
