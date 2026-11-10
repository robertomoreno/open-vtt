# Gather

A small, local-first virtual tabletop for your stories. Create or restore a game, open a shared room, choose approved player identities, and share dice rolls, table chat, and music. No accounts, application backend, gameplay relay, analytics, or cloud saves.

## Run

Use Node **22.12 or newer** and npm:

```sh
npm ci
npm run signal:start   # terminal 1: local signaling relay
npm run dev            # terminal 2
```

Open **http://localhost:5173**. The dev server binds only to localhost with a strict port. `file://` is unsupported. Development defaults to the bundled loopback WSS relay; production builds default to public Nostr relays with eight-relay redundancy. All participants in a room must use the same signaling provider configuration. Each remote participant runs their own copy or opens a static HTTPS deployment; a link containing your `localhost` does not expose your computer to friends.

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium firefox webkit
npm run test:e2e
```

`npm run test:e2e` starts the local relay and a dedicated dev server on port 5174 with local signaling; it does not contact public relays. `npm run test:e2e:nostr` is the opt-in real-browser gate for the production default: it starts the same dedicated dev server configured for `nostr` (no local relay) and exercises public relays. It passed on 2026-11-10 for Chromium↔WebKit in both directions; see `docs/superpowers/debugging/2026-11-10-nostr-provider-gate.md`. `dist/` contains the production static files. Serve them over HTTPS; no application server is needed. The current desktop Chrome, Firefox, Edge, and Safari are the compatibility targets. Feature detection explains unavailable APIs rather than crashing.

## Save and restore

- **New game:** enter a game name and your name. You become the first GM and the host. You can roll while alone.
- **Continue:** choose a saved game, then choose the existing player who will host this browser. The browser may suggest a remembered choice.
- **Delete saved game:** each saved game has a **Delete** button next to Continue. Confirmation is required, and deletion removes that game’s history, recovery copy, legacy save, and remembered player from this browser. Deletion is refused while another tab has that game open.
- **Load state file:** select a JSON file and review its game/player information. If its game ID already exists, **Replace saved game and open** explicitly replaces that browser save; **Cancel** preserves it. Invalid, oversized, or unsupported files never partially import.
- **Download game JSON:** every participant can export their latest state. Guest files are the **last received state**, not a guarantee of current host state after connection loss. No connection credentials or browser identity hints are exported.

Changes save automatically in this browser, separately for each game. Saves use IndexedDB for durable local storage, with recovery copies retained for failed or unwanted merges. Private-mode restrictions, quota, clearing browser data, or switching origins can lose browser saves. A persistent warning distinguishes in-memory play from failed saving; download JSON for a portable backup. Leaving an unsaved table asks for confirmation. Concurrent hosting of the same game in multiple tabs is **unsupported** and not synchronized.

Joining a host with a different copy of an already saved game asks before replacing that local record. **Cancel** preserves the existing save and keeps the live guest session in memory only, with file download available. This choice lasts for the session; it does not merge the two copies. Navigating away closes connections; returning from the browser’s back/forward cache remounts the saved-game start screen rather than reviving old peers.

Opening any saved snapshot starts an **independent new live session**. It preserves stable player IDs and recent history, but does not restore connections, merge diverged games, or migrate an existing host.

## Shared rooms

1. Host: **Connect**. The room opens, the invitation link is generated and copied to the clipboard, and the share panel tells you to send it through a trusted channel. Use **Share link** later to copy it again. The link is a transient room credential, not a permanent room URL.
2. Guest: open the link. It joins the room directly — no paste box or Join button. Different local app origins and paths are fine.
3. The first participant to open the room becomes the priority participant. Additional players can only be added after a connection is established and the game is synchronized; offline edits to existing players remain supported.
4. If the browser remembers a player for that game and it is free, it is claimed automatically. Otherwise the guest chooses from the available players. If every player is taken, the guest waits while the GM adds one.
5. Only the player currently seated in the **GM** role can add players. The GM's table shows an **Add player** form and a prompt when participants are waiting. Roles remain labels for everything else and are not authentication.

A room closes when its participants leave. The host tab no longer owns all live state; if the first participant leaves, the next-earliest connected participant takes over conflict decisions and play continues.

### Testing peer connections locally

Development and Playwright use the bundled loopback WSS relay by default, so no public signaling service is contacted (except the opt-in `npm run test:e2e:nostr` gate):

```sh
npm run signal:start   # terminal 1 (127.0.0.1:4444)
npm run dev            # terminal 2
```

Open a second tab or browser and join the room link.

To use a different dev relay, set `VITE_GATHER_SIGNALING_URLS` (loopback `ws://` endpoints are allowed in development) or persist an override in browser storage:

```js
localStorage.setItem('gather:dev:signaling', 'ws://127.0.0.1:4444');
location.reload();
```

When every configured signaling URL is loopback for the `wss` provider, the app also rewrites browsers' mDNS-obfuscated `.local` host candidates to `127.0.0.1` for that room. Some macOS/browser configurations cannot resolve those candidates across processes, which otherwise leaves ICE stuck at `checking`/`failed` even though signaling works. This fallback is dev-only and only valid because loopback signaling means every peer is on the same machine; it is **not** TURN and does not make remote peers or NAT traversal work.

If ICE still fails, check the browser's macOS Local Network and incoming-connections permissions; a firewall-blocked browser cannot receive WebRTC traffic. Firefox in particular may be blocked by the application firewall even when Chromium works.

If a connection fails, the table status now shows the transport error (for example, failed ICE or a room-password mismatch) instead of only “Waiting for connection.”

Stop the relay with `npm run signal:stop`.

### Signaling configuration

Gather supports two signaling providers: `wss`, a y-webrtc-compatible WebSocket relay, and `nostr`, public Nostr relays. The room link does not carry a provider hint, so every participant must use the same provider configuration.

| Variable | Values | Default |
|---|---|---|
| `VITE_GATHER_SIGNALING_PROVIDER` | `wss` or `nostr` | `nostr` in production; `wss` in development and Playwright |
| `VITE_GATHER_SIGNALING_URLS` | Comma-separated relay URLs | None (Trystero's public Nostr relays for `nostr`); the development `wss` default is `ws://127.0.0.1:4444` |
| `VITE_GATHER_SIGNALING_REDUNDANCY` | Integer 1–8, `nostr` only; used when no URL list is supplied | `8` |

- `VITE_GATHER_SIGNALING_URLS` without a provider implies `wss` for backward compatibility.
- A production `wss` configuration requires explicit URLs; there is no public y-webrtc fallback and no implicit endpoint.
- `wss` accepts 1–4 URLs. Development also accepts `ws://` URLs; URLs with credentials, query strings, or fragments are rejected.
- `VITE_GATHER_SIGNALING_REDUNDANCY` applies only to `nostr` and is rejected for `wss`. When no URL list is supplied it selects how many of the default relays receive an announcement: an integer from 1 to 8 (default 8). When `VITE_GATHER_SIGNALING_URLS` lists 1–8 relays, every listed relay is used and `redundancy` does not limit them.
- Invalid configuration stops startup with an error naming the invalid field; check the browser console for it. Gather never silently falls back to another provider or endpoint.
- In development only, `localStorage['gather:dev:signaling']` overrides the environment and accepts a JSON object (`{"provider":"wss","urls":["wss://relay.example"]}`) or the legacy comma-separated WSS URL list. It is ignored in production.

Nostr-only production build:

```bash
VITE_GATHER_SIGNALING_PROVIDER=nostr \
VITE_GATHER_SIGNALING_REDUNDANCY=8 \
npm run build
```

Self-hosted WSS production build:

```bash
VITE_GATHER_SIGNALING_PROVIDER=wss \
VITE_GATHER_SIGNALING_URLS=wss://relay.example \
npm run build
```

### Conflict and reconciliation rules

- Independent concurrent edits merge without warnings or data loss.
- Conflicting values for the same field retain the first room participant’s version, even when that participant authored neither competing change.
- Offline edits are not conflicts merely because another copy is unchanged; causality distinguishes competing edits from unchanged data.
- An edit made after receiving an earlier edit updates the value normally.
- When a conflict is resolved, a detailed warning lists the competing changes, the retained value, and why it won. Pre-merge recovery downloads retain the losing offline history.
- The successor’s current validated version becomes the starting fallback for their priority tenure; a fresh room starts from its opener’s saved version.

### Chat

Text is saved with the game and appears in the shared ledger beside rolls, with its author and time. Chat is public by default. Ticking **Private message** shows the roster and limits that entry to the named players; the sender is always included. Participants who are not named receive no entry at all, not even a placeholder. An offline recipient sees the message the next time they open the game and synchronize with the room.

`Private` is a UI convention among trusted participants, not access control or encryption. Every participant’s browser copy of the game contains the records, including messages they cannot see in the UI, and a decoded game backup contains them too. Use private chat only at a table where everyone is trusted; do not rely on it to keep secrets from someone who can open the save or the app.

Images can be attached to a message from the composer. Supported sources are PNG, JPEG, and WebP up to 10 MB; the browser resizes them to at most 1280 px and re-encodes until the shared image fits in 192 KiB. Images are live-only: they reach currently connected participants and disappear after a reload or when the room closes. A text caption sent with an image is saved and remains after the image is gone; an image sent without text leaves no saved record.

One message carries at most 2,000 characters and one image. Chat retains the newest **100 messages** (256 KiB total) and up to **4 live images** (192 KiB each, 512 KiB total).

### Music

Any seated player can add an audio file to the game’s shared library, select one track, start or stop it, seek, and set that track’s **Track volume (everyone)**. Each listener also has a private **Your volume (this device)** control for their own speakers; it is stored in that browser and never changes anyone else’s playback. One track plays at a time: there is no playlist, queue, automatic advance, mixing, or crossfade, and selecting another track stops the current one at 0:00. Supported files are MP3, M4A, AAC, OGG/Opus, WAV, WebM, and FLAC up to 10 MB.

Uploaded audio is distributed browser-to-browser, not streamed from a server. Every connected participant receives and stores a copy, and any participant who holds the bytes can later serve someone who joins without them. The app does not download the whole library in the background: it auto-fetches the track that is current in the room when this browser is missing it, and fetches other tracks on demand when someone selects them. Selecting a track requests its bytes from a connected holder, and **Retry download** appears for a current track that is not yet available here. If no connected participant has the file, the track stays listed as not available in this room — metadata alone cannot recreate the audio.

A participant who joins while a track is playing asks a connected holder for its current position before starting, and the panel labels a position derived only from the shared command timestamp as approximate; a synchronizing label appears while that position request is outstanding. If every holder answers with corrupt bytes, the app rotates to the next holder. A removal wins over an in-flight transfer: bytes that arrive after a track's tombstone are discarded and never stored.

The library metadata and tombstones are saved with the game, and each browser keeps its own audio bytes, so reopening a saved game on the same browser restores the tracks and their audio. A different browser or a restored JSON backup lists the tracks but must fetch each file from a connected holder; audio bytes are never included in JSON backups. Deleting a track removes its bytes on every peer that receives the tombstone, and a peer that is offline removes them when it next synchronizes. If browser storage fails, the track remains usable in memory for that session and must be fetched again after a reload.

Browsers may block sound until the page receives a user gesture. When that happens the panel shows **Enable sound**; press it once to start the current track. Headless automation cannot prove that sound is audible, so browser tests assert media state and the shared playhead instead.

Audio is shared with every room participant and has no encryption beyond the transport and no access control. Treat the whole table as trusted: every participant can receive, store, and play the library, and the shared gain is a listening preference, not a permission.

## Network privacy and limits

`src/network/config.ts` uses public Google STUN:

- `stun:stun.l.google.com:19302`
- `stun:stun1.l.google.com:19302`

STUN discovers network addresses; it does **not** relay game data. The service sees discovery traffic, including your public address.

Production signaling defaults to public Nostr relays with eight-relay redundancy; development and the default browser tests use the bundled loopback WSS relay and do not contact public relays (the opt-in `npm run test:e2e:nostr` gate does). Nostr relays see participants' IP addresses, a random per-page public key, ephemeral event kinds, a hashed room topic, timing, and payload lengths. SDP/ICE is encrypted with the room secret, and announcements contain a peer ID. Public relays have no SLA and can rate-limit, block ephemeral event kinds, or disappear. All participants in a room must use the same provider configuration; the room link does not carry a provider. Signaling exchanges room metadata only; it does not store gameplay state.

WebRTC offer/reply links contain network details and temporary connection credentials. Use trusted sharing channels. Long links can be truncated by messengers; the share panel keeps the full link as selectable text, and an incomplete link can be pasted into the address bar. Consumed incoming fragments are removed from the current address bar, but Gather cannot erase a messenger’s storage or promise control of browser history. SDP/ICE is never saved with a game or logged by the application.

No TURN relay is configured. Public signaling does not make restrictive networks connect. Corporate firewalls, restrictive NAT, or incompatible network policies can make direct connections impossible. Same-machine tests do not prove connectivity between homes.

Games support **32 players**, **100 recent rolls**, and one die per request (d4/d6/d8/d10/d12/d20/d100; default d20). The host supports at most 31 remote peers / 8 unapproved peers. Incoming requests have a 20-message burst and 10/second refill per peer. Accepted roll IDs remain deduplicated for that connection; after 4,096 accepted requests, reconnect to roll more. A flooding peer is closed independently. Frames are bounded to 16 KiB, reassembled messages to 2 MiB / 256 fragments, 4 incomplete transfers per peer within 10 seconds, and 16 MiB of pending inbound data per connection; outgoing buffering is limited to 1 MiB. Game files are capped at 1 MiB and portable backups at 4 MiB. The music library accepts files up to **10 MiB** and **4 hours** each, with a **12 MiB room audio payload ceiling**, at most **200 active tracks** and **200 tombstones** per game, a **64 KiB metadata budget**, and the newest **100 playback commands of at most 1 KiB each**; the 16 MiB pending-inbound and 2 MiB reassembled-message bounds are unchanged. History, causal operations, and chat retention (see **Shared rooms**) have finite bounds; the transient synchronization stage holds at most 1.75 MiB, and oversized backups are rejected.

## Compatibility

Current desktop Chrome, Firefox, Edge, and Safari are the compatibility targets. Feature detection explains unavailable APIs rather than crashing.

### Local relay and Nostr gate runs (2026-11-09/10, macOS)

- Development and `npm run test:e2e` use the bundled loopback relay; no public signaling server is contacted.
- The opt-in `npm run test:e2e:nostr` gate (public relays, no local relay) passed for Chromium↔WebKit in both directions on 2026-11-10: discovery through public Nostr relays opened native channels, 1.5 MB values matched byte-for-byte, delivery continued after the relay sockets were closed, and teardown succeeded. Two public relays were unreachable (one DNS, one HTTP 502) without blocking discovery; no event-kind rejection or rate limiting was observed. See `docs/superpowers/debugging/2026-11-10-nostr-provider-gate.md`.
- The local shared-room connection suite passes for Chromium↔Chromium and both Chromium/WebKit cross directions (run 2026-11-09; Chromium↔Chromium and Chromium↔WebKit rechecked 2026-11-10): room synchronization, claims, rolls, leave/rejoin, and download. WebKit↔WebKit passed in an earlier run but can flake at the player-claim step; that is a game-UI timing race, not a signaling failure.
- The shared-audio acceptance suite passes in headless Chromium: a >2 MiB WAV upload, holder fallback after the uploader leaves, same-browser persistence, shared play/seek/gain, and private device volume. Playwright launches Chromium with `--mute-audio`, so these tests assert media state and the shared playhead, not audible output.
- The chat, games, and reconciliation suites also passed in Chromium on 2026-11-10.
- Firefox directions fail on this runner because the macOS Application Firewall blocks incoming connections for the Playwright Firefox helper. Allow Firefox in System Settings → Network → Firewall to test it, or use Chromium/WebKit locally. This is an environment limitation, not a signaling-code failure.
- Public Nostr relays work from this runner, but cross-network behavior, branded Chrome/Edge/Firefox/Safari, and shipping Safari remain unverified; same-machine tests do not prove NAT traversal. WebKit automation is not shipping Safari.

### Previous public-endpoint run (2026-11-04, macOS, Playwright current)

- **312 unit/DOM tests passed**, with successful type checking and production build.
- **`npm run test:e2e`: 16 passed, 14 failed.** The full browser gate is **not green**.
- Non-connection browser tests pass in Chromium, Firefox, and WebKit: game creation, refresh/restore, portable file roundtrip, invalid/canceled imports, denied storage, missing WebRTC feedback, responsive layout, and keyboard roll.
- Shared-room connection tests fail because the public signaling endpoint was unreachable from this runner; `npm run check:signaling` reports `could not connect`. These failures are environmental traversal/service limitations, not observed application assertion failures, but they are not proof of compatibility.
- Reconciliation browser tests fail for the same signaling reason.
- Real Safari/Chrome, branded Edge/Firefox, and different-home-network smoke tests remain explicitly unrun.

WebKit automation is **not proof of shipping Safari behavior**, and Chromium automation is not a claim that branded Edge was tested.

## Structure

- `src/game/`: durable schema, validation, immutable operations, chat records and audiences (`chat.ts`), causal reconciliation, unbiased Web Crypto dice.
- `src/storage/`: IndexedDB-backed browser records, identity hints, validated JSON files, recovery copies.
- `src/network/`: room links, bounded framing, native WebRTC lifecycle, signaling provider/STUN configuration, shared size limits; no game rules/DOM.
- `src/session/`: causal peer session, membership, tenure, claims, request validation, chat and live-image staging, audio metadata/transfer orchestration, presence, snapshots; no storage/DOM.
- `src/ui/`: replaceable views and application wiring, including in-browser chat image preparation (`image.ts`), the persistent music controller (`audio.ts`), and the provisional music panel (`music.ts`). The game-room layout is intentionally provisional.

No maps, tokens, sheets, voice/video, cloud saves, automatic host migration, seamless reconnection, or PWA are included in this foundation.