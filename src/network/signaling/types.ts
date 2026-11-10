import type { JoinRoom, JoinRoomConfig } from '@trystero-p2p/core';

export type SignalingProviderId = 'wss' | 'nostr';

export type SignalingConfig =
  | { provider: 'wss'; urls: string[] }
  | { provider: 'nostr'; urls?: string[]; redundancy: number };

export type SignalingPlan = {
  id: SignalingProviderId;
  join: JoinRoom<JoinRoomConfig>;
  base: { appId: string; maxReceiveBytes: number; trickleIce?: boolean };
  relayConfig?: JoinRoomConfig['relayConfig'];
  allowsLoopbackCandidateFallback: boolean;
};
