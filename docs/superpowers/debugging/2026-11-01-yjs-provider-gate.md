# Yjs provider feasibility gate (Task 2) — 2026-11-01

Endpoint under test: `wss://y-webrtc-eu.fly.dev` (Task 1 default, `VITE_GATHER_SIGNALING_URLS`). No credentials, links, SDP/ICE or addresses are recorded here. The Playwright test creates a fresh random room link per run and never prints it.

## Result

The gate **passed for the two cases actually run**, while the endpoint was responsive:

| Host engine | Guest engine | Cases asserted | Result |
|---|---|---|---|
| Chromium | WebKit (Playwright) | real y-webrtc signaling; native opens > 0 on both; 1.5 MB binary value delivered with exact length+FNV-1a hash; data flows both ways after the page-side signaling sockets are closed; teardown (other side open count returns to 0) | pass (2 consecutive runs) |
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
