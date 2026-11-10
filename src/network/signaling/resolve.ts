import { createWssPlan } from './providers/wss';
import type { SignalingConfig, SignalingPlan } from './types';

export async function resolveSignalingPlan(
  config: SignalingConfig,
  options: { dev?: boolean } = {},
): Promise<SignalingPlan> {
  const dev = options.dev ?? import.meta.env.DEV;
  if (config.provider === 'wss') return createWssPlan(config, { dev });
  throw new Error('Nostr signaling is not implemented yet.');
}
