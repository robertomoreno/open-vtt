# Yjs provider feasibility gate (Task 2) — 2026-11-01

Endpoint under test: `wss://y-webrtc-eu.fly.dev` (Task 1 default, `VITE_GATHER_SIGNALING_URLS`). No credentials, links, SDP/ICE or addresses are recorded here. The Playwright test creates a fresh random room link per run and never prints it.

## Result

**Hard gate: NOT passed — blocked on BroadcastChannel (see below).** The provider/native-channel proof itself passed for the two cases actually run, while the endpoint was responsive:

| Host engine | Guest engine | Cases asserted | Result |
|---|---|---|---|
| Chromium | WebKit (Playwright) | real y-webrtc signaling; native opens > 0 on both; 1.5 MB binary values delivered byte-for-byte (full base64 string comparison against bytes generated independently in Node); before signaling closure a 1.5 MB value goes A→B; after the page-side signaling sockets are closed, small values go A→B and B→A and a 1.5 MB value goes B→A and then A→B (a different payload), each compared byte-for-byte; the `connected` phase is shown only while native opens > 0 and returns to `looking` when the last channel closes; teardown (other side open count returns to 0) | pass (2 consecutive runs) |
| WebKit (Playwright) | Chromium | same | pass (2 consecutive runs + 1 earlier pass) |

This does not prove Firefox, branded Safari/Edge, other networks, or the final compatibility matrix. WebKit automation is not shipping Safari.

## Endpoint reliability (observed, important)

The public endpoint is intermittently unresponsive from this network. Between about 12:45 and 12:57 UTC `check:signaling` and `curl` alternated between a prompt reply and 8–10 s timeouts (TCP connects, TLS/HTTP/WebSocket handshake stalls; DNS is fine), consistent with a cold or overloaded machine. A Node probe at 12:45 UTC failed; probes at 12:47, 12:56 and 12:57 UTC succeeded. When the endpoint stalled, the browser gate also failed (provider `connected`, i.e. discovery enabled, but zero native opens after 60 s) — one run of chromium→webkit failed at about 12:57 UTC for that reason, and an identical run minutes later passed. Treat the default as a **free best-effort endpoint**: a later task must surface a clear "signaling unavailable" state and document `VITE_GATHER_SIGNALING_URLS` for a user-chosen endpoint. Alternatives probed (`wss://demos.yjs.dev`, the two `y-webrtc-signaling-*.herokuapp.com` hosts) did not answer a ping and were not adopted.

## Notes

- Upstream y-webrtc applies remote Yjs updates before application observers run; nothing here claims input is validated before entering the transient document. This task does not bridge to a validated durable workspace.
- `provider.connected`/phase `connected` means discovery is enabled. Native opens are reported separately by the guarded runtime.
- `WebrtcProvider.destroy()` does not close signaling sockets; `close()` calls `disconnect()` then `destroy()` and then destroys awareness and the RTC runtime.

## Amendment: retained awareness bounds (after the first gate run)

`y-protocols` stores a remote awareness state before emitting `update`; the 2-MiB message/frame bounds remain the pre-parse guard. `room.ts` now removes invalid, over-8-KiB (UTF-8 bytes) and over-32-participant remote states from retained awareness via the public `removeAwarenessStates`, and keeps valid local/remote states. `y-protocols` is now a declared direct dependency (1.0.7, already installed transitively). Because `room.ts` changed, the Chromium↔WebKit gate was rerun: one run at ~13:06 UTC (first run after the new dependency import) had chromium→webkit fail a `toHaveText` assertion, which I did not diagnose (possibly the endpoint or a first-load Vite dependency re-optimisation; unconfirmed); one further run hung and was killed; later runs at ~13:23 and ~13:40 UTC passed 2/2. The same two cases only; no wider claim.


## Blocker: BroadcastChannel path (Critical review finding 1)

y-webrtc 10.3.0 also synchronizes same-origin tabs through lib0 `BroadcastChannel` (`Room.connect` always calls `bc.subscribe`). Those messages never pass through `wrtc`, framing, message budgets or channel limits. The provider options (`signaling`, `password`, `awareness`, `maxConns`, `filterBcConns`, `peerOpts`) contain no documented switch to disable or bound it; `filterBcConns` only filters peers already reachable by BroadcastChannel out of signaling. Disabling it would need a private hook, a vendored patch or replacing the global `BroadcastChannel` before lib0 loads (lib0 then falls back to a localStorage polyfill), all excluded by the task rules. Mitigating fact only (not a bound): BroadcastChannel payloads are AES-GCM encrypted with the room key, so only same-origin pages holding the room secret can inject. **No bound is enforced on that path; the technical gate is therefore recorded as blocked, and Task 3 must not assume otherwise** until a documented mechanism, an approved alternative (e.g. own provider), or an explicit scope decision resolves it.

## Fix round 2 (review findings 2–9 and phase labeling)

Awareness metadata pruned (public `awareness.meta`), per-connection one-channel cap, idle transfer expiry timer, guard failures close the channel and notify the owner, outbound overflow fails the connection, exact next-frame 1 MiB bound, room lock held through pending key derivation, `connected` derived from native opens only. Browser reruns this round (both Chromium↔WebKit directions, real y-webrtc): 13:48 and 13:49 UTC runs passed 2/2 each (endpoint warm). Earlier flakiness notes above still apply.


## Fix round 3

- Awareness metadata: `awareness.meta` is replaced by a Map subclass that caps stateless clock records at 64 at insertion (covers null-state unknown IDs that emit no `update`) and again by microtask after update events. Stale-clock records are kept (a delayed older state stays rejected) until evicted by the cap; an evicted client's very old state could be re-accepted, then validated/capped and expired by y-protocols after 30 s. Live states stay ≤ 32. Residual: within one synchronous message the count can transiently exceed the cap by that message's client count (bounded by the 2-MiB message limit), trimmed right after.
- Guard failures close the owning native connection and notify simple-peer (replayed `onclose` for handlers installed after an early failure; `iceconnectionstatechange` after abort for incoming-channel handler failures and excess channels). simple-peer itself is not driven in unit tests (fake native objects); this is not proven against its internal timers.
- Expired transfers fail the connection (`Peer transfer expired.`), and any expiry observed on a later frame throws.
- Peer-local guard errors no longer set the room phase `failed`; the error label is kept while the phase follows native opens.
- Room teardown: if the key never settles (rejected/hung derivation) no `status` arrives; teardown is forced after 10 s so the lock and owned awareness are released. Upstream's own rejected-key promise rejection cannot be caught without its private `provider.key`.
- The BroadcastChannel blocker above is unchanged: **Task 2's hard gate remains blocked; Task 3 stays paused.**


---

# Revised provider (Trystero Core 0.26.0 over public WSS) — gate status: NOT GREEN (endpoint unreachable)

Everything above is the history of the stock `y-webrtc@10.3.0` attempt, which was stopped by the BroadcastChannel blocker. The provider was revised (see `docs/superpowers/specs/2026-11-02-yjs-bounded-provider-design.md`). The revised transport uses `@trystero-p2p/core@0.26.0` directly with public `createTopicStrategy`, `rtcPolyfill`, `rtcConfig`, `maxReceiveBytes`, `onReceive`/`onReceiveProgress` and `getPeers`; no BroadcastChannel, umbrella package, vendored patch or global replacement.

## Observed results (2026-11-02, operator: Task 2 subagent, macOS, Node v26.5.0, Playwright Chromium + WebKit)

| Check | Result |
|---|---|
| Unit/DOM tests (`npm test`) | 25 files / 152 tests pass; the pre-existing Node ExperimentalWarning about `localStorage` remains |
| `npm run typecheck`, `npm run build` | pass |
| `npm run check:signaling -- wss://y-webrtc-eu.fly.dev` (revised random-topic subscribe/publish probe) | **fail**, 8+ attempts between 08:58 and 09:07 UTC: "could not connect" (TCP/TLS/WebSocket handshake stalls; `curl` to the host timed out after 8 s; DNS resolves). `wss://signaling.yjs.dev` and the two `y-webrtc-signaling-*.herokuapp.com` hosts also did not connect |
| Public gate, `interoperability` project, `provider-gate.spec.ts`, Chromium→WebKit and WebKit→Chromium | **fail, both directions** (09:01 and 09:04–09:06 UTC): native opens stayed 0 on the first page for 60 s because discovery never reached the relay |

**The technical gate is not green and Task 3 must not assume it is.** The failure is environmental (the public endpoint did not answer), not an observed application failure; it also means the endpoint's support for the custom topic/publish protocol is *unproven*, not disproven. Earlier (y-webrtc era) runs showed the same endpoint working intermittently, so a rerun when it answers is the next step.

## Diagnostic that is NOT gate evidence

To separate "endpoint down" from "application bug", an uncommitted temporary spec routed the page WebSockets (Playwright `routeWebSocket`) to an in-test topic relay implementing the same `subscribe`/`unsubscribe`/`publish` envelopes. Real Trystero Core, the real bounded RTC guard and real browser native data channels were used; only the signaling server was mocked. Chromium→WebKit and WebKit→Chromium both passed: native opens >0 on both sides, 1.5 MB values byte-for-byte both ways, small and large values still delivered after closing the signaling sockets, and teardown. This found and fixed a real bug (an incoming data channel that was already `open` at hand-off never delivered `open` to Trystero, so the peer never connected). It does not substitute for the public-endpoint gate.

## Hooks check

Trystero Core's public hooks were sufficient for every bound: `rtcPolyfill` wraps the native `RTCPeerConnection` (exact 16,384-byte physical frames, 1 MiB native buffer, one ordered/reliable channel per peer, ≤31 connections, 4/8 MiB outbound queues, 4 incomplete transfers/10 s expiry/8 MiB pending inbound), `onReceive` rejects >2 MiB payloads, a fifth pending transfer per peer and >8 MiB aggregate, and inactivity (10 s, extended by `onReceiveProgress`) closes the attributable peer via `getPeers()`. Not implemented: automatic signaling-socket reconnection (a dropped relay socket ends discovery; established channels continue).
