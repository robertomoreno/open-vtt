# Nostr relay console errors after GitHub Pages deployment (2026-11-11)

Status: fixed on 2026-11-11. The dead-relay console noise remains; the separate “Room discovery failed.” connection failure is fixed.

## Fix (2026-11-11): same-machine mDNS hosts

The deployed room could discover the other participant through Nostr but never
opened the WebRTC data channel. Both sides stayed at “Waiting for connection.”
until Trystero reported:

```text
could not connect to peer … after exchanging SDP; configure TURN servers …
```

which the table showed as “Room discovery failed.” This was **not** a Nostr
relay failure: discovery had already succeeded.

Two same-engine Playwright browser instances on the same Mac failed
(Chromium↔Chromium and WebKit↔WebKit), while Chromium↔WebKit passed. Both peers
advertised mDNS-obfuscated host candidates such as `<id>.local`; this
macOS/browser combination could not resolve those names across browser
processes, so ICE stayed at `checking`. Rewriting the incoming mDNS host to
`127.0.0.1` in a one-off browser init script made both same-engine pairs connect
immediately.

The permanent fix in `src/network/rtc-runtime.ts` keeps the original incoming
candidate and also calls `addIceCandidate` with the same UDP port on
`127.0.0.1`. A remote peer rejects the loopback pair and can still use the
original LAN/internet candidate; a peer on the same computer connects. This is
not TURN and does not change NAT or firewall limitations.

## Summary

After deploying to <https://robertomoreno.github.io/open-vtt/>, opening a room
shows repeated browser-console errors of the form:

```text
topic-strategy-*.js: WebSocket connection to 'wss://…' failed
```

Two public Nostr relays are involved. They are the two dead relays already
observed in the 2026-11-10 gate: one fails DNS resolution (`ENOTFOUND`) and one
returns HTTP 502 during the WebSocket handshake.

The app still discovers peers through the remaining six relays. The public
Nostr gate was re-run on 2026-11-11 and passed both Chromium↔WebKit directions
in 12.6 s. These errors are browser-level WebSocket failures for dead relays,
retried indefinitely by Trystero's socket layer with exponential backoff. They
are not application exceptions and they are not a total signaling failure.

## Deployment and configuration

- Live site: <https://robertomoreno.github.io/open-vtt/> (project page, Vite base
  `/open-vtt/`).
- Pages workflow: `.github/workflows/pages.yml`, run `43007089966` succeeded on
  2026-11-11.
- Provider: production `nostr`, `redundancy: 8`, no explicit relay URL list.
  The workflow pins `VITE_GATHER_SIGNALING_PROVIDER=nostr`,
  `VITE_GATHER_SIGNALING_REDUNDANCY=8`, and an empty
  `VITE_GATHER_SIGNALING_URLS`.
- The default relay list comes from `@trystero-p2p/nostr@0.26.0`.

## Reproduction

1. Open the deployed site.
2. Create or open a shared room.
3. Watch the browser console: repeated `WebSocket connection … failed` entries
   appear for the two dead relays.
4. Confirm discovery still works and exchange a roll or chat; before the
   2026-11-11 fix, same-engine same-machine pairs reached “Room discovery
   failed.” after SDP exchange even though Nostr discovered the peer.
5. Re-run the public gate: `npm run test:e2e:nostr`. On 2026-11-11 after the
   fix it passed 4/4 (both cross-engine directions and both same-engine pairs,
   14.4 s).

## Evidence (2026-11-11)

- Relay selection: the Nostr strategy calls
  `getRelays(config, defaultRelayUrls, 5, true)` with `appId: 'gather-v2'` and
  `redundancy: 8`. `getRelays` deterministically shuffles the 29 default relays
  by `appId`, then selects the first 8. The selected set is therefore stable
  for this app, but it is not the first 8 entries in the package source.
- Reachability of the selected 8: **6 reachable, 2 failed**.
  - Failure A: DNS `ENOTFOUND`.
  - Failure B: WebSocket handshake `Unexpected server response: 502`.
  - The two failing hosts match the two hosts in the browser console.
- Socket retry: `@trystero-p2p/core/dist/utils.mjs` `makeSocket` retries a
  closed socket with `defaultRetryMs = 3333`, doubling up to
  `maxRetryMs = 60000`, indefinitely. A failed handshake produces no Nostr
  message, so the strategy's terminal-rejection `retireRelay` path is never
  reached. The browser logs every attempt.
- `warnOnRelayFailure: false` only suppresses Trystero's own announce-failure
  `console.warn` in `core/dist/strategy.mjs`; it cannot suppress the browser's
  native WebSocket network errors.
- The original public gate passed only for Chromium↔WebKit. After the mDNS fix,
  all four pairs pass, including Chromium↔Chromium and WebKit↔WebKit. The local
  relay e2e suite is unaffected.

## Root cause

Two separate failures were present:

1. **Console noise:** two of the eight default relays selected for `gather-v2`
   are dead. Trystero's socket layer retries failed connections indefinitely
   with exponential backoff, and the browser logs each failed WebSocket. The
   app remains functional for signaling while at least one selected relay is
   healthy.
2. **No data channel:** same-machine peers exchanged mDNS `.local` host
   candidates that could not be resolved across browser processes. The app's
   existing loopback rewrite applied only to loopback WSS signaling, so the
   production Nostr room could discover the peer but never complete ICE. The
   RTC runtime now also tries each incoming mDNS host on `127.0.0.1` while
   retaining the original candidate.

## Impact

- **Functionality:** discovery works with 6/8 relays. Same-machine peers now
  connect through public signaling even when mDNS `.local` names cannot be
  resolved across browser processes. If more defaults die, `redundancy: 8` may
  leave too few healthy relays.
- **Remote peers:** unchanged. No TURN is configured, so restrictive NAT,
  corporate firewalls, and incompatible network policies can still prevent a
  direct connection.
- **UX:** repeated console errors can look like a broken app. There is no UI
  explanation for relay failures.
- **Privacy:** browser network errors expose relay hostnames to the user's
  console. Gather itself does not log endpoints in production. Committed
  reports, fixtures, and logs must keep endpoints redacted.

## Options for the remaining dead-relay console noise

1. **Pin a healthy explicit relay list in the Pages workflow.** Set
   `VITE_GATHER_SIGNALING_PROVIDER=nostr` and
   `VITE_GATHER_SIGNALING_URLS=wss://relay-a.example,wss://relay-b.example,…`
   with 4–6 maintained relays. `getRelays` uses the explicit list and ignores
   `redundancy`. All participants must use the same build. This removes the
   dead defaults but makes availability the operator's responsibility. Test
   with the public gate and two live browsers; update README/privacy notes.
2. **Keep the default list and document the noise.** Least invasive; the gate
   passes. Explain that dead public relays are retried and the app still works.
3. **Reduce `redundancy`.** Because of the app-id shuffle, a smaller set is not
   guaranteed to exclude the dead relays; not a robust fix.
4. **Filter known-dead relays at build time.** Similar to option 1; requires a
   maintained list and a rebuild when relays change.
5. **Upgrade Trystero** if a newer version retires handshake failures or reduces
   console noise. Check release notes and re-run the gate. Do not add a second
   retry loop in Gather; the spec assigns backoff/retire/resubscribe to
   Trystero.
6. **Optional diagnostics.** A non-blocking "some signaling relays are
   unavailable" status could help, but it is outside Phase 1 scope. Do not
   globally suppress browser network errors.

## Verification after deployment

The fix was deployed in Pages run `43015269419`. Two separate browser instances
of the same engine on the same Mac now create and join a room through public
Nostr relays, reach `Connected and synchronized`, and open the guest player
chooser without “Room discovery failed.” This was checked for Chromium↔Chromium
and WebKit↔WebKit. The public gate also passes all four engine pairs. The
dead-relay console noise remains and can be handled separately with option 1 or
2. If two different machines still fail, record the room phase/error and treat
it as a NAT/firewall limitation rather than a Nostr relay failure.

## Verification checklist for any change

- `npm run typecheck`
- `npm test`
- `npm run build:pages` and confirm `dist/index.html` uses `/open-vtt/assets/…`
- `npm run test:e2e:nostr` (public gate: Chromium↔WebKit both directions plus
  Chromium↔Chromium and WebKit↔WebKit)
- Two live browser contexts on the deployed site connect and exchange data
- No relay URLs or credentials in committed docs/logs/fixtures; all participants
  use the same provider configuration
- Local relay e2e still passes (37 passed / 5 known Firefox-environmental
  failures on this macOS runner)

## Commands and references

Reproduce the selected relays and their reachability (one-off; do not commit the
output, which contains endpoints):

```bash
node --input-type=module -e '
import { getRelays } from "@trystero-p2p/core";
import { defaultRelayUrls } from "@trystero-p2p/nostr";
console.log(getRelays(
  { appId: "gather-v2", relayConfig: { redundancy: 8 } },
  defaultRelayUrls,
  5,
  true,
));
'
```

Source references:

- `node_modules/@trystero-p2p/nostr/dist/index.mjs` — default relay list,
  `defaultRedundancy = 5`, `getRelays(..., true)`, `retireRelay`, announce
  backoff.
- `node_modules/@trystero-p2p/core/dist/utils.mjs` — `getRelays`, `makeSocket`
  socket retry (3.333 s → 60 s).
- `node_modules/@trystero-p2p/core/dist/strategy.mjs` — `warnOnRelayFailure`.
- `src/network/signaling/providers/nostr.ts` — Gather's relay config.
- `src/network/rtc-runtime.ts` — incoming mDNS host candidates also tried on
  `127.0.0.1`; original candidate retained.
- `src/network/signaling/config.ts` — provider defaults and validation.
- `.github/workflows/pages.yml` — Pages build environment.
- `docs/superpowers/debugging/2026-11-10-nostr-provider-gate.md` — previous
  gate record.

Gate command: `npm run test:e2e:nostr`.

## Privacy note

Exact relay endpoints are intentionally omitted from this committed report. The
browser console shows them to the user; the next session can reproduce the
selected set with the command above. Do not paste endpoints into committed
reports, fixtures, or logs.

## Deployment status

- Live: <https://robertomoreno.github.io/open-vtt/>
- Fix commit: `65a1a41` (2026-11-11).
- Last successful Pages run: `43015269419` (2026-11-11), deployed bundle
  `assets/index-Bs0_MqG4.js`.
- Live verification after deployment: two separate Chromium instances and two
  separate WebKit instances each created and joined a room through public Nostr
  relays, reached `Connected and synchronized`, and opened the guest player
  chooser without “Room discovery failed.”
- Current production config: Nostr, redundancy 8, no explicit relay list.
