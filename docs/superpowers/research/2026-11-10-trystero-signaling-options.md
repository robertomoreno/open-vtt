# Trystero signaling options without app-owned infrastructure

Date: 2026-11-10
Status: research only. No provider or implementation is selected by this document. The implementation that followed adopted the Nostr recommendation as the production default; see `docs/superpowers/specs/2026-11-10-signaling-providers-design.md`.

## Scope

Gather currently uses `@trystero-p2p/core@0.26.0` with a custom
y-webrtc-compatible WebSocket topic strategy. The question is how to keep
Trystero's room/action/WebRTC layer while making the **signaling channel**
configurable among options that do not require Gather to deploy and operate its
own signaling backend.

This document covers:

- the signaling strategies Trystero actually supports;
- their operational, privacy, bundle, and handshake implications;
- whether multiple channels can improve resilience and speed;
- a shape for a config-only abstraction layer that leaves `src/session/` and
  `src/ui/` unchanged.

It does **not** select a provider. It records evidence and a recommended path.

## Method and limits

Sources:

- Trystero 0.26 README, docs, releases, issues, and the published package
  source in `node_modules/@trystero-p2p/core`;
- the published `@trystero-p2p/{nostr,mqtt,torrent,ipfs,ws-relay}` 0.26
  packages;
- current public documentation for Nostr, MQTT, WebTorrent trackers, Waku,
  ntfy, PeerJS, and libp2p;
- a low-impact WebSocket reachability probe from this macOS environment on
  2026-11-10. The probe only opened sockets; it did not publish signaling,
  room data, SDP, or credentials.

The reachability numbers are a **single-network snapshot**, not a global
availability claim. "Socket opened" is not proof that a provider accepts a
Trystero announcement or that ICE succeeds. Full browser handshakes still need
the existing real-RTC gate.

## Executive summary

1. **The current production default is the weakest link.** The configured
   public y-webrtc endpoint (`wss://y-webrtc-eu.fly.dev`) timed out, and the
   other historical y-webrtc defaults were dead from this environment. The
   current custom adapter also does not reconnect after a socket close.
2. **Nostr is the best no-app-backend default.** It has a small strategy
   bundle (73.5 KB minified), the largest public relay pool, reconnect and
   rate-limit handling, and no extra runtime SDK beyond a secp256k1 signer.
   In this snapshot 25 of the 29 current default relays opened; the
   deterministic 5-relay selection for `appId: 'gather-v2'` only had 3 live
   relays, so the default redundancy should be raised or the relay list made
   explicit.
3. **MQTT is reachable but not production-grade public infrastructure.** All
   four default brokers opened with the correct `mqtt` WebSocket subprotocol,
   but they are explicitly test/public brokers with no SLA, visible messages,
   and rate limits. It is a reasonable optional secondary, not a default.
4. **BitTorrent/WebTorrent is a viable small secondary, not a primary.** The
   default three trackers opened, but the browser WebSocket tracker ecosystem
   is tiny and poorly monitored; two of the five current defaults were dead.
5. **The "IPFS" strategy is actually Waku.** `@trystero-p2p/ipfs` depends on
   `@waku/sdk`, starts a Waku light node, waits up to 7.5 seconds for peers,
   and ships an 800 KB minified bundle. It is not js-ipfs/libp2p pubsub. It is
   the heaviest and slowest option and should not be the default.
6. **Multiple channels are supported only within one strategy.** Trystero can
   run several relays per strategy (`init` returns an array, or
   `relayConfig.urls`). It does **not** compose multiple strategies into one
   room; upstream issue #100 is still open, and running two `joinRoom` calls
   creates duplicate WebRTC connections. True protocol diversity requires a
   custom topic transport fan-out inside one `createTopicStrategy`.
7. **Do not globally deduplicate across channels.** Trystero's signal handler
   already reuses one offer per peer and keys offer/answer state by relay. It
   is designed to tolerate the same announcement arriving on several relays.
   Suppressing the second copy removes the redundancy that makes multi-channel
   useful.
8. **No signaling change fixes NAT traversal.** Without TURN, some peer pairs
   will still fail after successful discovery. Public relays do not relay
   gameplay.

## What exists in Gather today

This section records the state at the time of the research, before the
signaling-provider implementation; production now defaults to Nostr with
eight-relay redundancy.

- `src/network/config.ts` resolves one list of y-webrtc-compatible WSS URLs,
  capped at four. Development defaults to `ws://127.0.0.1:4444`; production
  defaults to `wss://y-webrtc-eu.fly.dev`.
- `src/network/trystero-signaling.ts` implements a generic topic client
  (`subscribe` / `unsubscribe` / `publish`) and wraps it with Trystero Core's
  `createTopicStrategy`.
- `src/network/room.ts` hardcodes `appId: 'gather-v2'`, passes the room-link
  secret as Trystero's `password`, uses the current `AUDIO_TRANSFER_BYTES`
  (12 MiB) as `maxReceiveBytes`, injects the bounded RTC runtime, and calls the
  strategy.
- `RoomTransportOptions.join` is already an injection point for tests. The
  rest of the app depends on `RoomTransport`, not on Trystero directly.

The important current limitation: `createRelayClient` closes permanently on a
socket `error` or `close`. Unlike Trystero's Nostr/MQTT/torrent clients, it does
not reconnect, resubscribe, or replay announcements. A transient public-relay
failure therefore ends discovery for that room until it is reopened.

## Candidate channels

### Comparison

| Option | Package | App-owned infra | Extra public dependency | Minified bundle | Defaults | Reconnect | Handshake profile | Verdict |
|---|---|---|---|---|---|---|---|---|
| y-webrtc WSS | custom adapter | none, but public relay | one WSS endpoint | none (local code) | 1 production URL | no | fast when alive | keep as dev/self-host option; not default |
| Nostr | `@trystero-p2p/nostr` | none | public relays | 73.5 KB | 5 of 29, shuffled by app ID | yes, with backoff and resubscribe | fast warmup, 60 s steady | **primary candidate** |
| MQTT | `@trystero-p2p/mqtt` | none | public brokers | 389 KB | 4 | yes | subscribe ack, then fast | optional secondary |
| BitTorrent | `@trystero-p2p/torrent` | none | public WSS trackers | small; legacy comparison ~25 KB | 3 of 5 | yes | tracker offer/answer; 10 s announce | optional secondary |
| IPFS/Waku | `@trystero-p2p/ipfs` | none | Waku bootstrap/filter nodes | 800 KB | default bootstrap | SDK-managed | light node start, up to 7.5 s wait | not default |
| Firebase | `@trystero-p2p/firebase` | project/account | Google Realtime DB | 286 KB | project URL | SDK | fast | managed, not "no infra" |
| Supabase | `@trystero-p2p/supabase` | project/account | Supabase Realtime | 272 KB | project URL | SDK | fast | managed, not "no infra" |
| ntfy | custom | none | ntfy.sh | small | topic | HTTP/WS | 4 KB message cap, caching, rate limits | reject for signaling |
| PeerJS Cloud | not Trystero | none | PeerServer | medium | public PeerServer | client | fast | reject; different model, centralized |

Bundle sizes are the 0.26 release assets where published. They are standalone
minified strategy bundles, not the incremental cost in this app's code-split
build. Dynamic imports mean an unselected optional provider need not load.

### Nostr

**How it works.** Trystero publishes signed Nostr events in the ephemeral kind
range (20000–29999). The room topic is a SHA-1-derived string; the event carries
it in an `x` tag and uses a kind derived from the topic. Announcements contain
`{ peerId }` (and a passive flag); SDP/ICE signals are AES-GCM encrypted by
Trystero Core with a key derived from `password:appId:roomId`. Peers subscribe
to the root topic and their own per-peer topic.

**Strengths.**

- Largest pool of independent relays; no account or project.
- 0.26 handles rate-limited relays with backoff, retires incompatible relays,
  resubscribes after reconnect, and replays announcements.
- A small strategy dependency footprint: 73.5 KB minified, with no extra
  runtime SDK beyond a secp256k1 signer.
- 0.25.4 reduced steady-state announcements to once per minute after the
  startup burst, specifically to avoid overwhelming relays.

**Risks.**

- Public relays are third-party services with no SLA. They can rate-limit,
  require auth or proof-of-work, block ephemeral kinds, or disappear.
- Relays see IP address, random pubkey, event kind, hashed topic tag, timing,
  and content length. They cannot read encrypted SDP, but announcements are
  plaintext and traffic correlation remains possible.
- Relay policies are uneven. A relay that accepts a WebSocket may still reject
  Trystero's event kind.
- The deterministic default selection is not a health check. For
  `appId: 'gather-v2'`, the current 5-relay selection was
  `0x-nostr-relay.fly.dev`, `relay.nostrmap.net`, `nostr.robosats.org`,
  `relay.nostr.dev.br`, and `relay.novospes.com`; the first and third failed in
  this snapshot. Raising `redundancy` to 8 selected 6 reachable relays.

**Implication.** Nostr is the right default, but do not assume the default
five are healthy. Configure a higher redundancy or an explicit relay list that
is verified before release.

### BitTorrent / WebTorrent

**How it works.** Trystero's torrent strategy announces to WebSocket
BitTorrent trackers. The room topic is hashed into a tracker `info_hash`; the
browser sends WebRTC offers in tracker `announce` messages and receives answers.
It uses `createStrategy`, not topic pub/sub, and defaults to bundled ICE
(`trickleIce: false`).

**Strengths.**

- No extra runtime dependency; smallest strategy footprint.
- Three default trackers opened in this snapshot: `open.ftorrent.com`,
  `tracker.webtorrent.dev`, `tracker.openwebtorrent.com`.
- Useful as a completely different network path if Nostr/MQTT are blocked.

**Risks.**

- The browser WebSocket tracker ecosystem is very small. The public tracker
  list has only a handful of WSS entries, and they are not continuously
  validated with real WebTorrent announces.
- Two of the five current defaults were dead (`tracker.btorrent.xyz`,
  `tracker.files.fm`).
- Trackers see IP, peer ID, truncated room hash, and encrypted offers/answers;
  they can rate-limit or ban clients.
- No trickle ICE by default makes the initial handshake slower and more
  sensitive to candidate loss.
- Not compatible with Trystero's topic-strategy composite without a separate
  lower-level adapter.

**Implication.** Keep it as an optional secondary. Do not make it the only
discovery path.

### MQTT

**How it works.** `@trystero-p2p/mqtt` uses `mqtt` over WSS, subscribes to the
same hashed room topics, and publishes announcements/signals as MQTT payloads.
It batches subscriptions and reconnects.

**Strengths.**

- Four default public brokers; all four opened in this snapshot when the
  client sent the required `mqtt` WebSocket subprotocol:
  `broker.emqx.io:8084/mqtt`, `public.cloud.shiftr.io`,
  `broker.hivemq.com:8884/mqtt`, and `test.mosquitto.org:8081/mqtt`.
- Topic pub/sub maps cleanly onto Trystero's topic strategy.
- Public brokers are easy to try and require no account.

**Risks.**

- Public brokers are explicitly for testing/demo use, with no SLA. EMQX says
  all messages are visible to other users; HiveMQ says its shared broker is not
  for private or production data; Mosquitto's server is a test service;
  Shiftr's default has public credentials.
- Brokers see topics, payloads, and IPs. Signals are encrypted, but
  announcements are plaintext and topic hashes are correlatable.
- QoS 0 and public-broker rate limiting can drop messages; Trystero retries,
  but discovery can be intermittent.
- `mqtt` is the largest non-Waku dependency (389 KB minified).

**Implication.** Good optional secondary or diagnostic channel. Not the default
for a shipped table.

### IPFS / libp2p / Waku

The package name is misleading. `@trystero-p2p/ipfs@0.26.0` depends on
`@waku/sdk@^0.0.36` and uses `createLightNode({ defaultBootstrap: true })`.
It subscribes with Waku Filter and publishes with Waku Light Push. There is no
js-ipfs pubsub or generic libp2p rendezvous in the current strategy.

**Strengths.**

- No account or app-owned node.
- Topic-shaped API; it already uses `createTopicStrategy`.
- A genuinely different network from Nostr/MQTT/trackers.

**Risks.**

- 800 KB minified strategy bundle and a large transitive SDK.
- Startup waits for Waku peers for up to 7.5 seconds; if no peers are found it
  continues after the timeout, but discovery is then degraded.
- Fewer public peers and less operational history than Nostr.
- `trickleIce` defaults to false.
- Waku nodes see content topics, payloads, IPs, and timing. It is not
  anonymity infrastructure.
- It is not IPFS. If the requirement is specifically IPFS/libp2p, this package
  does not satisfy that requirement; a custom libp2p strategy would need a
  circuit relay and pubsub bootstrap infrastructure.

**Implication.** Do not make it the default. Keep it only as an explicit
opt-in for users who value the Waku network.

### Public y-webrtc WebSocket relays

The current strategy is small and simple, and development's loopback relay is
excellent for tests. Public endpoints are the problem:

- `wss://y-webrtc-eu.fly.dev` timed out.
- `wss://signaling.yjs.dev` no longer resolves.
- The two historical Heroku endpoints refused connections.

The current adapter also has no reconnect loop. If the socket closes, the room
keeps a dead strategy. This is strictly worse than Nostr's relay supervision.

**Implication.** Keep the WSS provider for the bundled loopback relay and for
operators who explicitly point it at their own signaling server. Do not use a
public y-webrtc endpoint as the production default. If it stays as a fallback,
add reconnect/resubscribe/replay first.

### Managed backends (Firebase, Supabase)

These avoid deploying a server but require an account, a project, security
rules, and vendor-specific SDKs. They are not decentralized and they do not
satisfy a strict "no third-party backend" requirement. They are useful as a
middle ground if a table needs higher availability and accepts the operational
setup. They are out of scope for the default recommendation.

### Other options considered

- **ntfy.sh.** Public topic pub/sub over WebSocket, no account. Rejected for
  signaling: 4 KB message cap is below some SDP sizes, messages are cached for
  hours, free-tier limits are IP-based (250 messages/day), and topic names are
  effectively passwords. It also lacks Trystero-native integration.
- **PeerJS Cloud.** A centralized PeerServer, and a peer-ID model rather than a
  room model. It does not remove the dependency; it changes it.
- **Gun.js public relays.** Theoretically usable as an SDP mailbox, but no
  Trystero strategy, unclear retention/rate-limit behavior, and more custom
  code than Nostr.
- **Manual SDP offer/answer links.** Zero signaling infrastructure, but high
  friction and not automatic discovery. Keep it as an emergency fallback, not
  as the main channel.
- **Public TURN.** TURN is a data relay, not signaling; free public TURN is
  rate-limited and privacy-sensitive. It does not answer this question.

## Live reachability snapshot (2026-11-10)

| Group | Probed | Opened | Notes |
|---|---:|---:|---|
| y-webrtc WSS defaults | 4 | 0 | current production URL timed out; others DNS/connection failures |
| Nostr current defaults | 29 | 25 | 4 failed: DNS, HTTP 502, HTTP 503, timeout |
| Nostr `gather-v2` default 5 | 5 | 3 | deterministic shuffle includes 2 dead relays |
| Nostr `gather-v2` redundancy 8 | 8 | 6 | more resilient, more sockets |
| MQTT defaults | 4 | 4 | all opened with `Sec-WebSocket-Protocol: mqtt` |
| WebTorrent defaults | 5 | 3 | default redundancy uses the first 3; all 3 opened |

The MQTT result is a good example of why the real client matters: a naive
WebSocket probe without the `mqtt` subprotocol reported two false failures.
Trystero's MQTT client uses the correct protocol, so the naive probe would have
misled the comparison.

## Multiple channels

### What Trystero supports natively

Trystero's `createTopicStrategy` accepts either one client or an array of client
promises from `init`. Each client becomes a separate relay ID. Core then:

- subscribes to the room topics on each relay;
- runs a separate announce schedule per relay;
- keys offer state by relay ID;
- reuses one offer per peer via `ensureOffer`;
- accepts the first answer and discards later duplicate answers;
- replays answers on a relay when a duplicate offer arrives there.

So multiple **endpoints within one strategy** are a supported, first-class
redundancy mechanism. `relayConfig.urls` uses the entire list; `redundancy`
selects how many defaults to use when no list is supplied.

### What Trystero does not support

It does not compose multiple strategy packages into one room. `joinRoom` is
idempotent only within one strategy module's closure. Two strategies produce
two rooms, two `RTCPeerConnection` instances per peer, two sets of actions, and
no cross-strategy peer deduplication. Upstream issue #100 ("Allow using multiple
strategies simultaneously") is still open; the maintainer has said the desired
solution is parallel strategies with peer deduplication, which does not exist
in 0.26. Issue #108 was closed by merging it into #100.

### Safe way to get protocol diversity

Use **one** `createTopicStrategy` with heterogeneous `TopicTransport` clients:

```ts
type TopicTransport = {
  readonly kind: 'wss' | 'nostr' | 'mqtt' | 'waku' | 'ntfy';
  readonly label: string;
  subscribe(topic: string, onMessage: (topic: string, data: StrategyMessage) => void): () => void;
  publish(topic: string, data: StrategyMessage): Promise<void>;
  close(): void;
};
```

`init` returns an array of these transports. The strategy, room, actions, and
data channels remain singular. WebSocket, Nostr, MQTT, and Waku are all
topic-shaped and can fit this interface. BitTorrent's tracker offer/answer
protocol does not; including it would require a separate lower-level
`createStrategy` multiplexer or leaving it as a standalone provider.

This is not built into Trystero. It requires adapters for Nostr/MQTT (or reuse
of their protocol code), per-transport reconnect/backoff, and tests. It is a
larger change than switching the provider.

### Handshake speed

The core schedule is a startup burst at roughly 233 ms, 533 ms, and 1333 ms,
then a steady interval. The default topic strategy steady interval is 60 s;
BitTorrent uses tracker-requested intervals (10 s active, 120 s dormant).
Nostr/MQTT use the topic default. The Waku strategy waits up to 7.5 s for peers
before it starts.

Multiple relays help tail latency: the first relay that delivers a valid
announcement can start the offer exchange, and the others provide a second path
if that message or answer is lost. They do not guarantee a faster median, and
they add connection setup and duplicate signaling traffic. The practical
sweet spot is a handful of well-connected relays, not an unbounded fan-out.
For a 32-player room, eight signaling sockets per peer is already a meaningful
amount of public-service load.

### Why sequential fallback is not enough

Starting strategy A, waiting ten seconds, then switching to B sounds simple but
partitions peers: Alice may see Bob on A and close B, while Bob only sees Alice
on B and closes A. Both end up in different rooms. A coordinated fallback needs
all participants to make the same decision at the same time, or a shared
control channel. A composite topic strategy avoids this because every peer is
in one room fed by all channels.

### Cost of multi-channel

- More sockets and battery/network use per participant.
- More public-service traffic and rate-limit exposure.
- More metadata spread across more operators; no additional content
  confidentiality, because the same encrypted signaling is copied.
- More bundle only if the optional providers are dynamically imported and
  actually selected; MQTT and Waku are not small.
- More failure modes, reconnect logic, and test matrix.

## Proposed abstraction layer

The goal is that changing provider is a configuration change, not a change in
`src/session/` or `src/ui/`, and that the provider-specific details stay inside
`src/network/`.

### Goals

- One `SignalingPlan` consumed by `createRoomTransport`.
- Provider selection and endpoint lists validated at load time.
- Dynamic imports so only the selected provider is loaded.
- Shared security and bounds: room-link secret as `password`, bounded RTC
  runtime, the current 12 MiB receive budget (`AUDIO_TRANSFER_BYTES`), STUN-only
  ICE, no endpoints from room links.
- No provider-specific fields leak into session/UI.
- A path to a composite plan without changing the room API.

### Interfaces

```ts
// src/network/signaling/types.ts
import type { JoinRoom, JoinRoomConfig, StrategyMessage } from '@trystero-p2p/core';

export type SignalingKind = 'wss' | 'nostr' | 'mqtt' | 'torrent' | 'waku';

export type SignalingChannel =
  | { kind: 'wss'; urls: string[] }
  | { kind: 'nostr'; urls?: string[]; redundancy?: number }
  | { kind: 'mqtt'; urls?: string[]; redundancy?: number }
  | { kind: 'torrent'; urls?: string[]; redundancy?: number }
  | { kind: 'waku' };

export type SignalingPlan = {
  id: string;
  join: JoinRoom<JoinRoomConfig>;
  base: Pick<JoinRoomConfig, 'appId' | 'maxReceiveBytes' | 'trickleIce'>;
  relayConfig?: JoinRoomConfig['relayConfig'];
  supportsLoopback: boolean;
};

export type TopicTransport = {
  readonly kind: SignalingKind;
  readonly label: string;
  subscribe(topic: string, onMessage: (topic: string, data: StrategyMessage) => void): () => void;
  publish(topic: string, data: StrategyMessage): Promise<void>;
  close(): void;
};
```

`base.appId` stays `gather-v2` for the no-infra providers. A managed provider
that needs a project URL would supply its own value, but that provider would
also be a deliberate, coordinated choice, not a local toggle.

### Provider registry

```ts
// src/network/signaling/index.ts
export async function resolveSignalingPlan(config: SignalingConfig): Promise<SignalingPlan> {
  if (config.mode === 'fanout') return createCompositePlan(config.channels);
  const provider = PROVIDERS[config.primary];
  if (!provider) throw new Error('Unsupported signaling provider.');
  return provider.create(config);
}
```

Each provider module owns its `joinRoom` import and its config mapping:

```ts
// src/network/signaling/nostr.ts
export async function createNostrPlan(config: NostrConfig): Promise<SignalingPlan> {
  const { joinRoom } = await import('@trystero-p2p/nostr');
  return {
    id: 'nostr',
    join: joinRoom,
    base: { appId: 'gather-v2', maxReceiveBytes: 12 * 1024 * 1024 },
    relayConfig: { urls: config.urls, redundancy: config.redundancy, warnOnRelayFailure: false },
    supportsLoopback: false,
  };
}
```

The WSS provider wraps the existing `createGatherSignalingStrategy`; the
composite provider uses `createTopicStrategy` with an array of
`TopicTransport`s.

### Integration in `room.ts`

`createRoomTransport` keeps its current public shape; add an optional
`plan`/`signaling` field for tests and advanced wiring:

```ts
const plan = options.plan ?? await resolveSignalingPlan(signalingConfig);
room = plan.join({
  ...plan.base,
  password: link.secret,
  relayConfig: plan.relayConfig,
  rtcConfig: roomNetworkConfig.rtc,
  rtcPolyfill: runtime.rtcPolyfill,
  ...(signalingIsLoopback && plan.supportsLoopback
    ? { _test_only_mdnsHostFallbackToLoopback: true }
    : {}),
}, link.roomId, {
  onPeerHandshake: handshake,
  onJoinError: details => { /* redacted generic error */ },
});
```

`src/session/peer.ts` continues to call `createRoomTransport` and does not
need to know which provider is active. `RoomTransportOptions.join` remains as
the deterministic test seam.

### Configuration shape

```ts
export const signalingConfig: SignalingConfig = {
  mode: 'single',
  primary: 'nostr',
  channels: {
    nostr: { urls: undefined, redundancy: 8 },
    mqtt: { urls: undefined, redundancy: 4 },
    torrent: { urls: undefined, redundancy: 3 },
    wss: { urls: [] },
  },
};
```

Examples:

- **Nostr default:** `mode: 'single'`, `primary: 'nostr'`,
  `redundancy: 8`. No endpoint list; Trystero maintains the defaults.
- **Nostr pinned:** set `channels.nostr.urls` to a verified list; all listed
  relays are used, and `redundancy` is ignored by Trystero.
- **WSS dev/self-hosted:** `primary: 'wss'`, `channels.wss.urls` set; dev
  loopback remains the default in `import.meta.env.DEV`.
- **Composite:** `mode: 'fanout'`,
  `channels: [{ kind: 'nostr' }, { kind: 'mqtt' }, { kind: 'wss' }]`.
  This mode is opt-in and requires the topic-transport adapters.

Environment/local-storage overrides should be parsed and validated by the same
code path as the static config. The production build should accept only
build-time configuration; the existing development-only localStorage override
can remain. Never accept a provider endpoint from a room link.

### Validation and safety

- Permit only `wss:` (and `ws:` for loopback in development).
- Per-provider URL limits: e.g. 1–8 Nostr relays, 1–4 MQTT brokers, 1–5
  trackers, 1–4 WSS relays. Do not reuse the current four-URL cap for all
  providers.
- Reject empty lists for providers that require URLs, and reject `urls` for
  providers that do not use them.
- Keep `password`, `rtcConfig`, `rtcPolyfill`, `maxReceiveBytes`, and the
  native runtime bounds owned by `room.ts`; provider adapters must not
  override them.
- Redact credentials and full endpoints from errors and UI. The public MQTT
  defaults include `public:public@`; that must never appear in a report.
- `supportsLoopback` is true only for the WSS provider. Public providers must
  not enable the mDNS-to-loopback test fallback.
- Keep `warnOnRelayFailure: false` in production; relay console noise is not a
  user-facing error.

### Migration phases

1. **Provider registry + Nostr default.**
   - Add the registry and `SignalingPlan`.
   - Switch production to Nostr with `redundancy: 8` or a verified list.
   - Keep the WSS provider for dev/self-hosted.
   - Update `config.test.ts`, `room.test.ts`, README, and the privacy notice.
   - Run the real two-browser gate against Nostr; record exact engines and
     network conditions.
2. **Optional MQTT and BitTorrent providers.**
   - Add them as dynamically imported, non-default plans.
   - Add unit tests for config mapping and failure isolation.
   - Do not include them in the default bundle.
3. **Composite topic plan (only if needed).**
   - Add `TopicTransport` adapters for Nostr and MQTT, and reconnect to the
     WSS adapter.
   - Keep one `createTopicStrategy` and one room.
   - Add failure-injection tests: one channel down, duplicate announcements,
     duplicate offers/answers, reconnect, and all channels down.
4. **UI/diagnostics.**
   - Optional: show a generic discovery mode and a redacted health state.
   - Do not show endpoints or credentials.

## Recommendation

**Default to Nostr as the single no-infra provider.** It has the best balance
of relay count, bundle size, reconnect behavior, and maintenance. Start with
`redundancy: 8` (or a verified explicit list) rather than the default five,
because the current deterministic five for `gather-v2` included two dead relays.

**Keep the WSS strategy as a development/self-hosted option, not a public
default.** The current public endpoint is dead from this environment, and the
adapter does not reconnect. If it remains a fallback, add reconnect,
resubscription, and announcement replay first.

**Treat MQTT and BitTorrent as optional secondary providers.** Both are
reachable, but public MQTT brokers are explicitly test infrastructure and the
browser WebSocket tracker ecosystem is small. They are useful diversity, not a
replacement for a primary.

**Do not make Waku/IPFS the default.** It is 800 KB, starts slowly, has fewer
peers, and is not IPFS.

**For multiple channels, start with multiple relays inside one strategy.** If
protocol diversity is still needed, build a composite `createTopicStrategy` over
`TopicTransport` adapters. Do not run multiple `joinRoom` instances in parallel;
that is the unsupported path with duplicate WebRTC connections.

**Keep the provider choice consistent across participants.** The signaling
provider is part of the rendezvous namespace, even though the room link does not
contain it. A build-time default avoids the "Alice uses Nostr, Bob uses MQTT,
they never meet" failure. If provider choice becomes user-facing, the room link
or an explicit pre-connection agreement must carry a non-secret provider hint.

**Do not claim TURN is solved.** None of these options relays gameplay. Pairs
behind restrictive NAT/firewalls still need TURN or fail.

## Open questions

1. Is the priority **availability** (Nostr + MQTT + trackers), **simplicity**
   (Nostr only), or **protocol diversity** (composite topic transport)?
2. Is an 8-relay Nostr default acceptable for the 32-player room bound, or
   should the app use a verified 5-relay list to reduce sockets and public load?
3. Are third-party public services acceptable for the intended users, or does
   "no infra" need to mean "no third-party dependency at all" (which would
   leave only manual SDP exchange/local discovery)?
4. Should provider selection be build-time only, or user-selectable? If
   user-selectable, how is the choice communicated to guests without putting
   endpoints in the room link?
5. Is there an acceptable TURN story for restrictive networks, or is that
   explicitly out of scope?

## Sources

- Trystero README: <https://github.com/dmotz/trystero>
- Signaling strategies: <https://trystero.dev/docs/signaling-strategies/>
- Upgrading to 0.26: <https://trystero.dev/docs/migration/>
- 0.26.0 release: <https://github.com/dmotz/trystero/releases/tag/0.26.0>
- 0.25.4 release: <https://github.com/dmotz/trystero/releases/tag/0.25.4>
- Multi-strategy issue #100: <https://github.com/dmotz/trystero/issues/100>
- Fallback issue #108: <https://github.com/dmotz/trystero/issues/108>
- Nostr relay load issue #192: <https://github.com/dmotz/trystero/issues/192>
- y-webrtc: <https://github.com/yjs/y-webrtc>
- Nostr NIP-01: <https://nips.nostr.com/1>
- Nostr relay communication: <https://nostrcg.github.io/devguide/protocol/relay-communication>
- WebTorrent: <https://webtorrent.org/>
- Public WebSocket trackers: <https://github.com/ngosang/trackerslist>
- Tracker ecosystem analysis: <https://docs.ftorrent.com/tracker-lists.html>
- EMQX public broker: <https://www.emqx.com/en/mqtt/public-mqtt5-broker>
- HiveMQ public broker: <https://www.hivemq.com/mqtt/public-mqtt-broker/>
- Waku JavaScript SDK: <https://docs.waku.org/build/javascript>
- Waku light push/filter: <https://docs.waku.org/build/javascript/light-send-receive>
- libp2p browser connectivity: <https://libp2p.io/docs/browser-connectivity/>
- ntfy limitations: <https://docs.ntfy.sh/publish/#limitations>
- PeerJS FAQ: <https://peerjs.com/client/faq>
- Trystero vs PeerJS: <https://trystero.dev/guides/trystero-vs-peerjs>
