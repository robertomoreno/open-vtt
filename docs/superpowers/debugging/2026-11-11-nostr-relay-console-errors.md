# Nostr relay console errors after GitHub Pages deployment (2026-11-11)

Status: open — handoff for the next session. No fix has been applied.

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
4. Confirm discovery still works (the room can reach `connected` and exchange
   rolls/chat) or record the failure if it cannot.
5. Re-run the public gate: `npm run test:e2e:nostr`. On 2026-11-11 it passed
   2/2 (Chromium↔WebKit both directions, 12.6 s).

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
- The public gate still passes with the six healthy relays. The local relay e2e
  suite is unaffected.

## Root cause

Two of the eight default relays selected for `gather-v2` are dead. Trystero's
socket layer retries failed connections indefinitely with exponential backoff,
and the browser logs each failed WebSocket. The app remains functional while at
least one selected relay is healthy; the console noise is expected until the
dead relays leave the selected set or Trystero retires handshake failures.

## Impact

- **Functionality:** discovery works with 6/8 relays and the gate passes. If
  more defaults die, `redundancy: 8` may leave too few healthy relays.
- **UX:** repeated console errors can look like a broken app. There is no UI
  explanation for relay failures.
- **Privacy:** browser network errors expose relay hostnames to the user's
  console. Gather itself does not log endpoints in production. Committed
  reports, fixtures, and logs must keep endpoints redacted.

## Options for the next session (not yet chosen)

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

## Recommended next step

Verify a real two-browser connection on the deployed site: create a room in one
browser, join from another, and exchange a roll or chat message. Record whether
both reach `connected` and stay connected. If yes, choose between option 1
(pin a healthy list) and option 2 (accept and document). If no, treat it as a
separate signaling failure and capture the room phase/error and the number of
reachable relays.

## Verification checklist for any change

- `npm run typecheck`
- `npm test` (519 tests at the 2026-11-11 head)
- `npm run build:pages` and confirm `dist/index.html` uses `/open-vtt/assets/…`
- `npm run test:e2e:nostr` (public gate, Chromium↔WebKit both directions)
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
- Last successful Pages run: `43007089966` (2026-11-11)
- Current production config: Nostr, redundancy 8, no explicit relay list.
