# Gather: configurable Trystero signaling providers (Phase 1)

Status: proposed by the agent on 2026-11-10 after the signaling research.
Implementation planning is authorized; application changes require the user to
review the plan and choose an execution method first.

Related research:
`docs/superpowers/research/2026-11-10-trystero-signaling-options.md`

## Intent

Keep Trystero's room, action, and native WebRTC data-channel layer unchanged
while making the **signaling provider** a build-time configuration choice. The
first production default should be Nostr, because the current public y-webrtc
WebSocket endpoint is dead from the development environment and the custom WSS
adapter has no reconnect path. The existing loopback WSS relay must remain the
development and browser-test default so the deterministic local gate keeps
working.

Phase 1 adds two providers:

- `wss` — the existing y-webrtc-compatible custom topic strategy, used for the
  bundled loopback relay, tests, and explicitly configured self-hosted relays.
- `nostr` — `@trystero-p2p/nostr@0.26.0`, using public relays and Trystero's
  reconnect, backoff, subscription replay, and relay supervision.

The abstraction is deliberately shaped so MQTT, BitTorrent, Waku, and a future
composite topic transport can be added as new provider modules without changing
`src/session/`, `src/ui/`, or the room API.

## Confirmed decisions

- The room link format does not change. It still carries only `version`,
  `roomId`, `gameId`, and the 32-byte `secret`; it never carries a provider,
  endpoint, SDP, ICE, or game state.
- `appId` stays `gather-v2`; `roomId` stays the opaque link value; the room-link
  secret stays Trystero's `password`.
- Nostr is the production default with `redundancy: 8` initially. The current
  deterministic 5-relay selection for `gather-v2` had only three reachable
  relays in the 2026-11-10 snapshot; eight is a starting point, not a promise.
- Development and Playwright keep the loopback WSS relay
  `ws://127.0.0.1:4444` by default. Existing local tests must not start
  contacting public Nostr relays implicitly.
- Provider choice is part of the rendezvous namespace: all participants in one
  room must use the same provider configuration. A build-time default avoids
  the "Alice uses Nostr, Bob uses MQTT, they never meet" failure.
- No provider is selected by the room link and no endpoint is accepted from an
  imported file, invitation, or peer message.
- The existing security and resource rules remain in force: SDP/ICE are
  encrypted with the room secret; no game state is sent through signaling; no
  SDP/ICE or credentials are logged; the bounded native RTC runtime, the
  current 12 MiB room receive budget (`AUDIO_TRANSFER_BYTES`), STUN-only ICE,
  and participant/transfer limits are unchanged.
- No TURN is added. Signaling provider changes do not solve restrictive NAT or
  firewall traversal.
- MQTT, BitTorrent, Waku, and composite multi-strategy fan-out are **out of
  scope for Phase 1**. They remain documented options for a later phase.

## Goals

- Resolve one `SignalingPlan` from validated build-time configuration.
- Make `createRoomTransport` consume that plan instead of hardcoded WSS URLs.
- Default production to Nostr while keeping development on the loopback WSS
  relay.
- Preserve the existing `RoomTransport` contract, room-link behavior, session
  authority, reconciliation, privacy, and bounds.
- Keep `src/session/` and `src/ui/` free of provider-specific types.
- Make adding another provider a new module plus registry entry, not a change
  in room/session/UI code.
- Add focused tests for defaults, overrides, validation, loopback behavior, and
  the exact config passed to Trystero.
- Verify the local WSS gate still passes and run a real-browser Nostr gate
  before claiming the production default is accepted.

## Non-goals

- A provider-selection UI or per-user provider preference.
- A provider hint in the room link.
- Running multiple Trystero strategies in parallel.
- A composite `TopicTransport` fan-out over several protocols.
- MQTT, BitTorrent, Waku, Firebase, or Supabase providers.
- TURN, public TURN, a gameplay relay, or any server deployment.
- Changing room-link format, session authority, reconciliation rules, chat,
  audio, or game data.
- Changing Trystero's action wire format or the bounded native RTC runtime.
- Claiming public relay availability from a single network snapshot.

## Architecture

### Current path

`createRoomTransport` calls `createGatherSignalingStrategy()` (custom
y-webrtc WSS) and passes a hardcoded config. `src/network/config.ts` resolves a
single WSS URL list at module load. The rest of the app depends only on
`RoomTransport`.

### New path

```text
environment + dev override
        │
        ▼
parseSignalingConfig() ──► SignalingConfig
        │
        ▼
resolveSignalingPlan() ──► SignalingPlan { id, join, base, relayConfig, loopback }
        │
        ▼
createRoomTransport(doc, link, participantId, { plan? })
        │
        ▼
plan.join({ ...plan.base, password: link.secret, rtcConfig, rtcPolyfill, relayConfig }, link.roomId)
```

`SignalingPlan` is the only provider-specific value that crosses into
`room.ts`. Provider modules own their `joinRoom` import and their config
mapping. `room.ts` continues to own the room secret, RTC configuration,
bounded RTC runtime, receive budget, handshake, and action wiring.

### Types

```ts
// src/network/signaling/types.ts
import type { JoinRoom, JoinRoomConfig } from '@trystero-p2p/core';

export type SignalingProviderId = 'wss' | 'nostr';

export type SignalingConfig =
  | { provider: 'wss'; urls: string[] }
  | { provider: 'nostr'; urls?: string[]; redundancy: number };

export type SignalingPlan = {
  id: SignalingProviderId;
  join: JoinRoom<JoinRoomConfig>;
  base: {
    appId: string;
    maxReceiveBytes: number;
    trickleIce?: boolean;
  };
  relayConfig?: JoinRoomConfig['relayConfig'];
  allowsLoopbackCandidateFallback: boolean;
};
```

`base.appId` is `gather-v2`. `base.maxReceiveBytes` is the current
`AUDIO_TRANSFER_BYTES` value (12 MiB), imported from
`src/network/limits.ts`; do not duplicate or lower it. `trickleIce` is omitted
in Phase 1 so Trystero's default (true for both providers) applies. `relayConfig.warnOnRelayFailure` is `true`
in development and `false` in production. `relayConfig.urls` is used when the
operator supplies endpoints; otherwise Nostr uses `redundancy`.

`allowsLoopbackCandidateFallback` is true only when the provider is `wss`, the
build is development, and every configured URL has a loopback host. It replaces
the current module-level `signalingIsLoopback`.

### Configuration

Production defaults:

```text
provider = nostr
redundancy = 8
urls = none (Trystero's maintained defaults)
```

Development/test defaults:

```text
provider = wss
urls = ws://127.0.0.1:4444
```

Build-time overrides:

- `VITE_GATHER_SIGNALING_PROVIDER=wss|nostr`
- `VITE_GATHER_SIGNALING_URLS` — comma-separated WSS URLs for the selected
  provider. If set without a provider in production, it implies `wss` for
  backward compatibility.
- `VITE_GATHER_SIGNALING_REDUNDANCY` — integer 1–8 for Nostr when no explicit
  URL list is supplied.

Development-only override:

- `localStorage['gather:dev:signaling']` may contain either:
  - a JSON object `{ "provider": "wss"|"nostr", "urls"?: string[], "redundancy"?: number }`; or
  - the legacy comma-separated WSS URL string.

Production builds never read this key. Invalid overrides must throw at load
time rather than silently falling back, matching the current behavior.

Validation:

- Provider must be `wss` or `nostr`.
- URLs must be `wss:`, or `ws:` only in development. Reject credentials,
  fragments, query strings, empty hosts, and malformed URLs.
- WSS requires 1–4 URLs in production. In development, omitted WSS URLs default
  to the loopback relay. A production build must not fall back to a public
  y-webrtc endpoint.
- Nostr accepts 0–8 explicit URLs. If none are supplied, `redundancy` must be
  an integer 1–8.
- Unknown fields and invalid combinations are rejected.
- Never accept a provider or endpoint from a room link.

### Provider modules

```text
src/network/signaling/
  types.ts          types and config shape
  config.ts         env/localStorage parsing, defaults, loopback detection
  resolve.ts        config -> SignalingPlan
  providers/wss.ts  wraps createGatherSignalingStrategy
  providers/nostr.ts dynamic import of @trystero-p2p/nostr
  providers/index.ts registry (Phase 1: two entries)
```

`resolve.ts` dispatches through the registry. Provider modules are dynamically
imported only when selected, so the production WSS/self-hosted path does not
load the Nostr dependency and the development path does not load Nostr.

### Room integration

`RoomTransportOptions` gains `plan?: SignalingPlan`. `createRoomTransport`
resolves `options.plan ?? resolveSignalingPlan(signalingConfig)` before
starting. `options.join` remains a test seam and overrides `plan.join`; the
plan still supplies the base config and relay config.

`room.ts` passes:

- `...plan.base`
- `password: link.secret`
- `relayConfig: plan.relayConfig`
- `rtcConfig: rtcConfiguration`
- `rtcPolyfill: runtime.rtcPolyfill`
- `_test_only_mdnsHostFallbackToLoopback: true` only when
  `plan.allowsLoopbackCandidateFallback`

It continues to call `join(config, link.roomId, callbacks)` with the existing
`onPeerHandshake` and `onJoinError`.

### Failure behavior

- Invalid build-time configuration fails at module load; the app does not
  silently switch providers.
- A provider import or `join` failure reports the existing safe message
  `The room transport could not be loaded.` / `The room transport could not
  start.` No endpoint, credential, SDP, or room secret is included.
- Signaling errors remain per-room discovery errors; existing native data
  channels survive signaling loss exactly as they do today.
- Nostr relay failures are Trystero's responsibility (backoff, retire,
  resubscribe, replay). Gather does not add a second retry loop in Phase 1.
- No peer connection is reported until a native data channel opens.

## Privacy and compatibility

Nostr relays see IP addresses, a random per-page pubkey, ephemeral event kinds,
a hashed room topic, timing, and payload lengths. They cannot decrypt SDP/ICE
without the room secret, but announcements contain a peer ID and traffic
correlation remains possible. Public relays are third-party best-effort
services with no SLA. The README must disclose this.

The room link remains provider-free. Users joining the same room must run the
same provider configuration. A production build defaults to Nostr; a
self-hosted deployment may select WSS. Mixing providers splits the room.

Room links, game saves, exports, diagnostics, and fixtures must never contain
SDP, ICE, relay URLs, or credentials. The existing privacy rules remain.

## Test strategy

Unit:

- Defaults: development WSS loopback; production Nostr with redundancy 8.
- Explicit provider and URL overrides; legacy URL-only override implies WSS.
- Invalid providers, schemes, credentials, counts, redundancy, and
  development-only WSS behavior.
- Development localStorage JSON and legacy CSV; production ignores
  localStorage.
- WSS plan: exact `relayConfig`, loopback flag, dynamic import path.
- Nostr plan: exact `relayConfig` (`redundancy` or `urls`), no loopback flag,
  dynamic import path.
- `room.ts`: plan supplies `appId`, `maxReceiveBytes`, `relayConfig`,
  `password`, `rtcConfig`, `rtcPolyfill`, and the mDNS fallback only for the
  loopback WSS plan.

Regression:

- Existing `tests/network/room.test.ts`, `room-core.test.ts`,
  `trystero-signaling.test.ts`, and config tests, updated for the new config
  shape.
- `npm run typecheck`, `npm test`, `npm run build`.
- Existing Playwright local-relay gate must still pass; development must not
  contact public Nostr.

Real-browser Nostr gate:

- With `VITE_GATHER_SIGNALING_PROVIDER=nostr`, two isolated browser contexts
  create/open the same room, open native data channels, exchange a small value
  and a large binary value in both directions, and keep working after the
  signaling sockets close. Record exact engines and network conditions.
- If public Nostr relays are unreachable or a relay rejects the Trystero event
  kind, stop and report the blocker. Do not claim the Nostr default is accepted
  based on unit tests or the loopback WSS gate.

## Acceptance criteria

- `src/network/room.ts` contains no hardcoded public WSS URL and no
  `roomNetworkConfig.signaling`.
- Production default resolves to a Nostr plan with `appId: 'gather-v2'`,
  `redundancy: 8`, `warnOnRelayFailure: false`, and the room secret as
  `password`.
- Development default resolves to the loopback WSS plan and preserves the
  existing local relay/Playwright behavior.
- A production WSS configuration with no URLs is rejected; there is no silent
  fallback to the dead public endpoint.
- Existing room links work unchanged with both providers.
- Adding a future provider requires only a new provider module and registry
  entry.
- All unit/typecheck/build checks pass, and the local-relay browser gate is
  green.
- The real-browser Nostr gate is either green with recorded engines/network or
  explicitly reported as a blocker. A partial or unit-only result is not
  acceptance.

## Open decisions for the user

- Is `redundancy: 8` the preferred starting point, or should Phase 1 use a
  verified explicit relay list?
- Is the real-browser Nostr gate required before merge, or can it be a
  post-merge deployment check if public relays are unavailable?
- Should Phase 2 add MQTT/BitTorrent/Waku providers next, or only after the
  Nostr default has run in real tables?
