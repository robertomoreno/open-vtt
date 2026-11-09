# Local signaling and mDNS candidates (2026-11-09)

## Scope

Investigated why two browser tabs stayed in `waiting` while using the bundled
loopback relay (`npm run signal:start`) and the dev signaling override
(`VITE_GATHER_SIGNALING_URLS=ws://127.0.0.1:4444`). No game rules, storage or
room-link behavior was involved.

## Symptoms

- The relay logged each client connecting and subscribing to the room topic and
  its own peer topic.
- Announce, offer, answer and candidate publishes were delivered to one client
  on the shared topics, so signaling fan-out worked in both directions.
- Browsers logged `[Gather signaling] open ... topics= 2`, but never
  `[Gather room] handshake start` or `peer join`.
- Both sides remained in the session `waiting` phase.

## Investigation

The transport layer was instrumented temporarily at the browser boundary to log
RTCPeerConnection state changes and ICE candidate types (candidate contents were
not persisted). With two tabs of the same Chromium build, and with
Chromium/WebKit, the exchange always reached:

- an encrypted SDP offer and answer in both directions,
- host candidates of the form `xxxxxxxx-....local` (mDNS-obfuscated loopback
  interfaces),
- server-reflexive candidates that both resolved to the same public address.

The ICE connection then went `checking` → `disconnected`/`failed`. No candidate
pair succeeded, so no data channel opened and Trystero never ran its handshake.
Rewriting the `.local` host candidates to `127.0.0.1` made ICE connect and the
data channel open immediately, proving the signaling and transport code were
not at fault.

## Verification

- The local provider gate (real Chromium/WebKit data channels, large binary
  payloads, signaling-loss survival) passes **2/2** against the local relay.
- The shared-room e2e flow passed for Chromium↔Chromium and both
  Chromium/WebKit cross directions. WebKit↔WebKit passed in an earlier run but
  later exposed a separate player-claim timing flake (the creator's own newly
  claimed player can be marked Occupied before selection); that is a game-UI
  race, not a signaling failure.
- Firefox directions still failed at ICE. This is a separate environment
  limitation: the macOS Application Firewall reports the Playwright Firefox
  helper (`plugin-container.app`) as **Block incoming connections**. Firefox
  fails even when host candidates use the real LAN address instead of mDNS.
  Allowing the browser in the OS firewall is a user decision; the acceptance
  gate must not change firewall or privacy settings to force a pass.

## Cause

In this environment, browsers could not resolve each other's ephemeral mDNS
hostnames across browser processes. The only remaining candidates were STUN
server-reflexive addresses; two peers behind the same NAT cannot reach each
other through that public address when the router has no hairpin support. The
result is a failed ICE negotiation with no application-level error visible in
the UI before this change.

This is an environment/browser limitation, not proof that a particular browser
family is incompatible. Granting the browser macOS Local Network permission may
also change mDNS behavior.

## Fix

- `src/network/config.ts` exposes `signalingIsLoopback` (dev builds only, every
  signaling URL has a loopback host).
- `src/network/room.ts` passes Trystero Core's
  `_test_only_mdnsHostFallbackToLoopback` option only in that mode. It rewrites
  mDNS host candidates to `127.0.0.1`. The mode is safe because loopback
  signaling means all participants are on the same machine.
- The session view now exposes `connectionError` and the table shows it, so
  failed ICE or a room-password mismatch no longer looks like an indefinite
  wait.
- Dev logs now include the resolved signaling mode, transport errors and
  Trystero join errors (no SDP or credentials are logged).

## Test configuration

- Development and the Playwright suite use the bundled loopback relay by default;
  they do not contact the public signaling endpoint. Production builds keep the
  public WSS default (or an explicit override).
- `playwright.config.ts` starts the relay and a dedicated dev server on port
  5174 with `VITE_GATHER_SIGNALING_URLS=ws://127.0.0.1:4444`, so it cannot
  silently reuse a developer's app or fall back to public WSS.
- The provider gate connects directly to the local relay. It still intercepts
  the loopback WebSocket only to close it later and prove native channels
  survive signaling loss.

## Limits

- The fallback does not apply to public/remote signaling, and production builds
  never enable it.
- It is not a substitute for TURN. It does not fix NAT traversal, public relay
  reachability or cross-network acceptance.
- The provider gate still uses real browsers and real data channels; a local
  relay run exercises the application/transport path but is not proof of
  public signaling or mDNS/NAT behavior.
