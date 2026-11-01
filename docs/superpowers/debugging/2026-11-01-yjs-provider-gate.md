# Yjs provider feasibility gate (Task 2) — 2026-11-01

Endpoint under test: `wss://y-webrtc-eu.fly.dev` (Task 1 default, `VITE_GATHER_SIGNALING_URLS`). No credentials, links, SDP/ICE or addresses are recorded here. The Playwright test creates a fresh random room link per run and never prints it.

## Result

**Hard gate: NOT passed — blocked on BroadcastChannel (see below).** The provider/native-channel proof itself passed for the two cases actually run, while the endpoint was responsive:

| Host engine | Guest engine | Cases asserted | Result |
|---|---|---|---|
| Chromium | WebKit (Playwright) | real y-webrtc signaling; native opens > 0 on both; 1.5 MB binary values delivered byte-for-byte (full base64 comparison against bytes generated independently in Node), in both directions; after the page-side signaling sockets are closed, small values and a 1.5 MB value flow A→B and B→A over the established channels; the `connected` phase is shown only while native opens > 0 and returns to `looking` when the last channel closes; teardown (other side open count returns to 0) | pass (2 consecutive runs) |
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
