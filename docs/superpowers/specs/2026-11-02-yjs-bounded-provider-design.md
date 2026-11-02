# Gather: bounded Yjs peer transport provider revision

Status: approved by the user on 2026-11-02 after an independent builder check. This addendum supersedes only the provider-specific decisions in `2026-11-01-yjs-local-first-sync-design.md`; all other approved gameplay, causal-reconciliation, local-storage, privacy, and UI requirements remain in force.

## Why this revision exists

The original implementation plan selected `y-webrtc@10.3.0`. Its provider always subscribes to and publishes document/awareness messages over a same-origin `BroadcastChannel`; those messages bypass native RTC frame, queue, and peer bounds. The user chose to revise the provider while retaining resource limits across all message paths. Same-origin BroadcastChannel is not an allowed exception.

## Approved provider choice

- Use `@trystero-p2p/core@0.26.0` directly. Do not use the umbrella `trystero` package's default Nostr strategy and do not use `y-webrtc` as the document provider.
- Implement a Gather signaling adapter with Trystero Core's documented `createTopicStrategy` extension point. Configure the existing public WSS signaling list through `relayConfig.urls`; use `VITE_GATHER_SIGNALING_URLS` as the validated build-time override and never accept relay URLs from a room link.
- The strategy speaks generic topic `subscribe` / `unsubscribe` / `publish` JSON supported by the current y-webrtc-compatible signaling endpoint. Its `publish.data` carries only Trystero peer announcements and encrypted WebRTC session descriptions/candidates. Verify this protocol with the live provider gate. If the endpoint is incompatible or no public compatible endpoint is verified, stop; do not self-host or add a state relay.
- Use Trystero's room actions for direct peer data. Yjs updates and small typed presence messages travel only over native WebRTC data channels; no app/game state is sent through the signaling strategy.
- Pass the room-link secret as Trystero's `password` so SDP/ICE signaling content is encrypted. Use a fixed, non-user-specific application ID and the opaque room ID as the room namespace. The relay still sees IPs, topic identifiers, timing, and encrypted traffic metadata. Possession of the link grants collaboration; it is not authentication.
- Pass `rtcConfig` with exactly the two approved Google STUN URLs from `src/network/config.ts`; this replaces Trystero's default ICE list. Do not configure TURN or a relay fallback.
- Inject the guarded native `RTCPeerConnection` wrapper using the documented `rtcPolyfill` constructor. Report connected only after an actual native RTC data channel opens. Do not count relay connection, room membership, or signaling status as peer connectivity.
- Do not use BroadcastChannel, global API replacement, private Trystero internals, a vendored patch, or an alternate transport to a state server.

## Bounded action and document flow

The network adapter owns a transient Yjs staging document. It is not a durable workspace or accepted game state. `src/session/` remains responsible for validating staged semantic operations before admission to the durable workspace; no post-update observer is described as having rejected a raw Yjs update before it entered staging.

The provider's public actions carry binary Yjs updates and small typed presence/control payloads. Validate sizes and allowed payload shapes before application code uses them. In addition to Trystero's documented `maxReceiveBytes` and `onReceive` hooks, enforce the approved budgets at the native RTC runtime boundary:

| Resource | Bound |
|---|---:|
| Physical native frame / header | 16,384 / 16 bytes |
| Reassembled application message / chunks | 2 MiB / 256 |
| Incomplete transfers per connection / inactivity timeout | 4 / 10,000 ms |
| Aggregate pending inbound bytes | 8 MiB |
| Outbound queue per connection / total | 4 MiB / 8 MiB |
| Native channel buffered bytes / low threshold | 1 MiB / 65,536 bytes |
| Remote connections / admitted participants / pending admissions | 31 / 32 / 8 |
| Encoded durable workspace / game operations / causal parents | 1 MiB / 4,096 / 128 |
| Pending missing-dependency operations | 128 |
| Transient control entries / encoded control bytes / presence bytes | 256 / 128 KiB / 8 KiB |
| Action tokens per participant | burst 20, refill 10/second; sync fragments are not actions |

Set Trystero's room receive budget to 8 MiB and reject individual app payloads larger than 2 MiB through `onReceive`. Track incomplete application transfers and pending receive decisions per peer; reject/close at the approved count and byte limits and apply the 10-second inactivity deadline. Account for Trystero's room/action envelopes when enforcing the native physical-frame limit; provider defaults do not replace the Gather runtime guard.

Use the same protocol version, room/game IDs, 32-byte random secret, and fragment-only room-link format defined in the original spec. A link contains no game snapshot, SDP, ICE, or relay endpoint. No shared-room or local-save contents are uploaded to relays.

## Provider evidence and remaining gate

Trystero Core 0.26.0 documents `createTopicStrategy`, `rtcPolyfill`, `rtcConfig`, `maxReceiveBytes`, `onReceive`, and `getPeers`. Its published Core distribution defines a 16-KiB action-frame limit and contains no `BroadcastChannel` reference. These are candidate implementation hooks, not an acceptance claim: verify adapter integration, actual public relay compatibility, and every Gather bound in focused tests and a real-browser gate.

Before starting the causal-workspace task, unit tests must prove message-size, transfer-count, aggregate-budget, queue, channel-count, receive-admission, timeout, malformed-input, and teardown behavior through the public strategy/action and injected native RTC boundary. The actual Playwright Chromium↔WebKit gate must use isolated contexts and the public WSS strategy; assert native opens on both peers, byte-for-byte large binary delivery, continued direct-channel operation after signaling loss, and teardown. No mocks, BroadcastChannel-only result, relay, `.skip`, or privacy-flag changes may substitute for this gate. A partial matrix remains partial; WebKit automation is not shipping Safari, and Chromium automation is not branded Edge.

If the custom strategy or public Trystero Core hooks cannot meet these requirements, pause and present the concrete blocker. Do not silently relax the all-path bounds or claim the gate passed.
