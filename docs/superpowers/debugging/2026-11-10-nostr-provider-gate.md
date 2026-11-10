# Public Nostr provider gate — 2026-11-10

Real-browser gate for the production signaling default (`@trystero-p2p/nostr@0.26.0`,
`redundancy: 8`, dynamic import). It runs `tests/e2e/nostr-gate.spec.ts` through
`playwright.nostr.config.ts`: a Vite dev server started with
`VITE_GATHER_SIGNALING_PROVIDER=nostr`, an empty `VITE_GATHER_SIGNALING_URLS` and
`VITE_GATHER_SIGNALING_REDUNDANCY=8`, and **no** local signaling relay. The page
talks directly to public Nostr relays.

## Result

**Gate passed: 2/2 cases, three times.** Both cross-engine directions opened native
RTC channels through public Nostr discovery, carried 1.5 MB binary values
byte-for-byte, kept working after the page-side relay sockets were closed, and
tore down cleanly.

| Run (UTC) | Cases | Result |
|---|---|---|
| 2026-11-10 14:08:18–14:08:31 | Chromium → WebKit, WebKit → Chromium | 2 passed (12.8 s) |
| 2026-11-10 14:09:01–14:09:10 | Chromium → WebKit, WebKit → Chromium | 2 passed (8.5 s) |
| 2026-11-10 14:18:26–14:18:36 | Chromium → WebKit, WebKit → Chromium | 2 passed (9.1 s) |

The third run is the clean final run: no process was listening on the loopback
relay port, confirming the gate cannot have used local signaling.

Command: `npm run test:e2e:nostr`
(`playwright test -c playwright.nostr.config.ts`).

## Environment

- macOS 26.7.2 (build 25G332), public internet access, no VPN or proxy on the runner.
- Node.js v26.5.0, npm, Playwright 1.64.1.
- Engines: Chromium 156.0.8078.4 (Playwright build), WebKit 27.2 (Playwright build),
  Firefox 157.0 (used only by the separate local-relay suite).
- The bundled loopback relay was **not** running and is not started by this config;
  the default `npm run test:e2e` relay setup is untouched.

## Relay reachability (observed)

- Each page opened 8–10 WSS relay sockets across 8 distinct public Nostr relay hosts
  (`redundancy: 8` of Trystero's default relay set).
- 6 of the 8 hosts accepted the WebSocket connection and relayed discovery events;
  both peers found each other within a few seconds.
- 2 hosts failed at the transport level on every run: one hostname no longer
  resolves (DNS NXDOMAIN) and one returned HTTP 502 during the WebSocket handshake.
  These failures are expected with a free public relay set and did not prevent
  discovery. Exact relay URLs are redacted here per the privacy rules.
- **No rate-limit, auth-required, or event-kind rejection messages were observed.**
  No relay rejected the ephemeral event kind used by Trystero.
- Both test runs succeeded with the same relay set; the failures were stable, not
  intermittent.

A throwaway diagnostic copy of the gate (deleted, never committed) logged socket
close codes to confirm the above: 6 sockets stayed open for the duration and 2
closed with code 1006 after the DNS/handshake failures. It did not change the gate.

## Large binary result

The gate publishes a deterministic 1.5 MB value generated independently in Node
and in the browser (`(i * 31 + seed * 17 + (i >> 8)) & 255`) and compares the
complete base64 text. Both directions matched **byte-for-byte**:

- before closing the relay sockets: Alice → Bob, seed 7;
- after closing every relay socket on both pages: Bob's small message still
  arrived at Alice, and Alice → Bob seed 11 still matched exactly.

This exercises the real bounded native RTC runtime and framing, not a mock. The
1.5 MB payload is well below the 12 MiB receive budget.

## Scope of this evidence

This proves the Nostr provider plan works end-to-end in Playwright Chromium and
WebKit on one machine with public relays reachable. It does **not** prove:

- branded Chrome/Edge/Safari or shipping Safari (WebKit automation is not Safari);
- Firefox for the Nostr provider (Firefox was not part of this gate);
- connections between different home networks, restrictive NAT, or corporate
  firewalls — same-machine tests do not prove NAT traversal;
- long-term relay availability. Public relays have no SLA and can rate-limit,
  block ephemeral kinds, or disappear; `redundancy: 8` is the mitigation.

## Full regression on the same runner

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | 43 files / 448 tests passed |
| `npm run build` | pass (Vite 7.3.7 production build) |
| `npm run test:e2e` (loopback relay) | 34 passed, 5 failed |

The 5 failures are all `connections.spec.ts` cases that involve Firefox:
firefox↔firefox, chromium→firefox, firefox→chromium, firefox→webkit,
webkit→firefox. Each stalls before a peer connects, so the GM's **Add player**
form never enables (`toBeEnabled` timeout at 60 s). This matches the previously
documented macOS Application Firewall limitation for the Playwright Firefox
helper, not an application assertion failure. All other cases pass:
Chromium↔Chromium, WebKit↔WebKit, Chromium↔WebKit and WebKit↔Chromium shared-room
flows, both local-relay provider-gate directions, chat, and the per-browser
non-connection suites.
