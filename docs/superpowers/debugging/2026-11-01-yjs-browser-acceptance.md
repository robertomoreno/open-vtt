# Yjs browser acceptance (2026-11-04)

## Scope

Final browser acceptance for the Gather Yjs local-first migration. Tests run with the public application signaling/STUN configuration; no mocked WebRTC, fake RTC, skipped cases, or changed ICE privacy flags.

## Runner

- Date: 2026-11-04
- Platform: macOS (darwin), Node 22.12+/npm
- Playwright: configured engines chromium, firefox, webkit
- Tested endpoint/operator: public signaling `wss://y-webrtc-eu.fly.dev` (default in `src/network/config.ts`); STUN `stun:stun.l.google.com:19302`, `stun:stun1.l.google.com:19302`
- Signaling probe: `npm run check:signaling wss://y-webrtc-eu.fly.dev` → `could not connect to wss://y-webrtc-eu.fly.dev`

## Results

Command: `npm run test:e2e`

- Total: 30 tests
- Passed: 16
- Failed: 14
- Duration: ~14.7 minutes

### Passing

- `[chromium|firefox|webkit]` compatibility: denied browser storage leaves local play and downloads usable
- `[chromium|firefox|webkit]` compatibility: missing WebRTC explains unsupported connection operations without crashing
- `[chromium|firefox|webkit]` games: create refresh restore and portable file roundtrip
- `[chromium|firefox|webkit]` games: invalid and canceled replacement imports preserve existing saves
- `[chromium|firefox|webkit]` games: responsive keyboard forms preserve die selection and safe text
- `[interoperability]` provider-gate: local relay bridge closes a pending loopback connection when the browser route closes

### Failing (environmental signaling limitation)

- `[interoperability]` connections: all 9 engine directions (chromium↔chromium, firefox↔firefox, webkit↔webkit, chromium↔firefox, firefox↔chromium, chromium↔webkit, webkit↔chromium, firefox↔webkit, webkit↔firefox) — timeout waiting for room synchronization/player creation after `joinSharedRoom`; no native channel established.
- `[chromium|firefox|webkit]` reconciliation: offline forks merge... — timeout waiting for `Available saved player` to become visible after join.
- `[interoperability]` provider-gate: chromium↔webkit and webkit↔chromium real Trystero Core signaling over public WSS — timeout waiting for native channel open count to leave 0.

### Engine directions covered

All nine connection directions were executed, not skipped:

1. chromium host ↔ chromium guests
2. firefox host ↔ firefox guests
3. webkit host ↔ webkit guests
4. chromium host ↔ firefox guests
5. firefox host ↔ chromium guests
6. chromium host ↔ webkit guests
7. webkit host ↔ chromium guests
8. firefox host ↔ webkit guests
9. webkit host ↔ firefox guests

### Phase/error

Connection-dependent tests stop in the `waiting`/`syncing` phase (no open RTC connections) and time out at the 60–180s test timeout. No application assertion failure was observed beyond the environmental inability to establish a channel.

### Redacted network limitations

- Public signaling endpoint `wss://y-webrtc-eu.fly.dev` was unreachable from this runner during the run.
- No TURN relay is configured; only public Google STUN is used.
- Same-machine/runner conditions are not proof of home-network traversal.
- WebKit automation is not proof of shipping Safari behavior; Chromium automation is not proof of branded Edge behavior.
- Real Safari↔Chrome, Edge↔Firefox, and different-home-network smoke tests remain unrun.

## Conclusion

The browser acceptance gate is **not green**. Non-connection UI/storage/browser tests pass. Shared-room and reconciliation acceptance cannot be verified in this environment because public signaling is unreachable. Tests are preserved; no cases were skipped or replaced with mocks.