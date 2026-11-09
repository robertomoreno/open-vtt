# Gather

A small, local-first virtual tabletop for your stories. Create or restore a game, open a shared room, choose approved player identities, and share dice rolls. No accounts, application backend, gameplay relay, analytics, or cloud saves.

## Run

Use Node **22.12 or newer** and npm:

```sh
npm ci
npm run signal:start   # terminal 1: local signaling relay
npm run dev            # terminal 2
```

Open **http://localhost:5173**. The dev server binds only to localhost with a strict port. `file://` is unsupported. Development defaults to the bundled loopback relay; set `VITE_GATHER_SIGNALING_URLS` to use another relay. Production builds default to the public WSS endpoint unless configured. Each remote participant runs their own copy or opens a static HTTPS deployment; a link containing your `localhost` does not expose your computer to friends.

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium firefox webkit
npm run test:e2e
```

`npm run test:e2e` starts the local relay and a dedicated dev server on port 5174 with local signaling; it does not contact the public endpoint. `dist/` contains the production static files. Serve them over HTTPS; no application server is needed. The current desktop Chrome, Firefox, Edge, and Safari are the compatibility targets. Feature detection explains unavailable APIs rather than crashing.

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

Development uses the bundled loopback relay by default, so no public signaling server is contacted:

```sh
npm run signal:start   # terminal 1 (127.0.0.1:4444)
npm run dev            # terminal 2
```

Open a second tab or browser and join the room link. Production builds require `wss://` and default to the public endpoint.

To use a different dev relay, set `VITE_GATHER_SIGNALING_URLS` (loopback `ws://` endpoints are allowed in dev) or persist it in browser storage:

```js
localStorage.setItem('gather:dev:signaling', 'ws://127.0.0.1:4444');
location.reload();
```

When every configured signaling URL is loopback, the app also rewrites browsers' mDNS-obfuscated `.local` host candidates to `127.0.0.1` for that room. Some macOS/browser configurations cannot resolve those candidates across processes, which otherwise leaves ICE stuck at `checking`/`failed` even though signaling works. This fallback is dev-only and only valid because loopback signaling means every peer is on the same machine; it is **not** TURN and does not make remote peers or NAT traversal work.

If ICE still fails, check the browser's macOS Local Network and incoming-connections permissions; a firewall-blocked browser cannot receive WebRTC traffic. Firefox in particular may be blocked by the application firewall even when Chromium works.

If a connection fails, the table status now shows the transport error (for example, failed ICE or a room-password mismatch) instead of only “Waiting for connection.”

Stop the relay with `npm run signal:stop`.

### Conflict and reconciliation rules

- Independent concurrent edits merge without warnings or data loss.
- Conflicting values for the same field retain the first room participant’s version, even when that participant authored neither competing change.
- Offline edits are not conflicts merely because another copy is unchanged; causality distinguishes competing edits from unchanged data.
- An edit made after receiving an earlier edit updates the value normally.
- When a conflict is resolved, a detailed warning lists the competing changes, the retained value, and why it won. Pre-merge recovery downloads retain the losing offline history.
- The successor’s current validated version becomes the starting fallback for their priority tenure; a fresh room starts from its opener’s saved version.

## Network privacy and limits

`src/network/config.ts` uses public Google STUN:

- `stun:stun.l.google.com:19302`
- `stun:stun1.l.google.com:19302`

STUN discovers network addresses; it does **not** relay game data. The service sees discovery traffic, including your public address. Production signaling uses the configured WSS endpoint (`wss://y-webrtc-eu.fly.dev` by default); development and browser tests use the bundled loopback relay and do not contact it. Signaling exchanges room metadata only; it does not store gameplay state. WebRTC offer/reply links contain network details and temporary connection credentials. Use trusted sharing channels. Long links can be truncated by messengers; the share panel keeps the full link as selectable text, and an incomplete link can be pasted into the address bar. Consumed incoming fragments are removed from the current address bar, but Gather cannot erase a messenger’s storage or promise control of browser history. SDP/ICE is never saved with a game or logged by the application.

No TURN relay is configured. Corporate firewalls, restrictive NAT, or incompatible network policies can make direct connections impossible. Same-machine tests do not prove connectivity between homes.

Games support **32 players**, **100 recent rolls**, and one die per request (d4/d6/d8/d10/d12/d20/d100; default d20). The host supports at most 31 remote peers / 8 unapproved peers. Incoming requests have a 20-message burst and 10/second refill per peer. Accepted roll IDs remain deduplicated for that connection; after 4,096 accepted requests, reconnect to roll more. A flooding peer is closed independently. Frames are bounded to 16 KiB, reassembled messages to 256 KiB / 128 chunks, 4 incomplete transfers / 10 seconds, and outgoing buffering to 1 MiB. JSON imports are capped at 1 MiB. History and causal operations have finite bounds; oversized backups are rejected.

## Compatibility

Current desktop Chrome, Firefox, Edge, and Safari are the compatibility targets. Feature detection explains unavailable APIs rather than crashing.

### Local relay run (2026-11-09, macOS)

- Development and `npm run test:e2e` use the bundled loopback relay; no public signaling server is contacted.
- The local shared-room connection suite passes for Chromium↔Chromium and both Chromium/WebKit cross directions: room synchronization, claims, rolls, leave/rejoin, and download. WebKit↔WebKit passed in an earlier run but can flake at the player-claim step; that is a game-UI timing race, not a signaling failure.
- Firefox directions fail on this runner because the macOS Application Firewall blocks incoming connections for the Playwright Firefox helper. Allow Firefox in System Settings → Network → Firewall to test it, or use Chromium/WebKit locally. This is an environment limitation, not a signaling-code failure.
- Public-WSS and cross-network behavior remain unverified; the 2026-11-04 record below was blocked by public endpoint reachability.

### Previous public-endpoint run (2026-11-04, macOS, Playwright current)

- **312 unit/DOM tests passed**, with successful type checking and production build.
- **`npm run test:e2e`: 16 passed, 14 failed.** The full browser gate is **not green**.
- Non-connection browser tests pass in Chromium, Firefox, and WebKit: game creation, refresh/restore, portable file roundtrip, invalid/canceled imports, denied storage, missing WebRTC feedback, responsive layout, and keyboard roll.
- Shared-room connection tests fail because the public signaling endpoint (`wss://y-webrtc-eu.fly.dev`) is unreachable from this runner; `npm run check:signaling` reports `could not connect`. These failures are environmental traversal/service limitations, not observed application assertion failures, but they are not proof of compatibility.
- Reconciliation browser tests fail for the same signaling reason.
- Real Safari/Chrome, branded Edge/Firefox, and different-home-network smoke tests remain explicitly unrun.

WebKit automation is **not proof of shipping Safari behavior**, and Chromium automation is not a claim that branded Edge was tested.

## Structure

- `src/game/`: durable schema, validation, immutable operations, causal reconciliation, unbiased Web Crypto dice.
- `src/storage/`: IndexedDB-backed browser records, identity hints, validated JSON files, recovery copies.
- `src/network/`: room links, bounded framing, native WebRTC lifecycle, public signaling/STUN configuration; no game rules/DOM.
- `src/session/`: causal peer session, membership, tenure, claims, request validation, presence, snapshots; no storage/DOM.
- `src/ui/`: replaceable views and application wiring. The game-room layout is intentionally provisional.

No maps, tokens, sheets, chat, voice/video, cloud saves, automatic host migration, seamless reconnection, or PWA are included in this foundation.