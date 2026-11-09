# Gather

A small, local-first virtual tabletop for your stories. Create or restore a game, open a shared room, choose approved player identities, and share dice rolls. No accounts, application backend, gameplay relay, analytics, or cloud saves.

## Run

Use Node **22.12 or newer** and npm:

```sh
npm ci
npm run dev
```

Open **http://localhost:5173**. The dev server binds only to localhost with a strict port. `file://` is unsupported. Each remote participant runs their own copy or opens a static HTTPS deployment; a link containing your `localhost` does not expose your computer to friends.

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium firefox webkit
npm run test:e2e
```

`dist/` contains the production static files. Serve them over HTTPS; no application server is needed. The current desktop Chrome, Firefox, Edge, and Safari are the compatibility targets. Feature detection explains unavailable APIs rather than crashing.

## Save and restore

- **New game:** enter a game name and your name. You become the first GM and the host. You can roll while alone.
- **Continue:** choose a saved game, then choose an existing player for this hosting browser or create a new GM. The browser may suggest a remembered choice.
- **Load state file:** select a JSON file and review its game/player information. If its game ID already exists, **Replace saved game and open** explicitly replaces that browser save; **Cancel** preserves it. Invalid, oversized, or unsupported files never partially import.
- **Download game JSON:** every participant can export their latest state. Guest files are the **last received state**, not a guarantee of current host state after connection loss. No connection credentials or browser identity hints are exported.

Changes save automatically in this browser, separately for each game. Saves use IndexedDB for durable local storage, with recovery copies retained for failed or unwanted merges. Private-mode restrictions, quota, clearing browser data, or switching origins can lose browser saves. A persistent warning distinguishes in-memory play from failed saving; download JSON for a portable backup. Leaving an unsaved table asks for confirmation. Concurrent hosting of the same game in multiple tabs is **unsupported** and not synchronized.

Joining a host with a different copy of an already saved game asks before replacing that local record. **Cancel** preserves the existing save and keeps the live guest session in memory only, with file download available. This choice lasts for the session; it does not merge the two copies. Navigating away closes connections; returning from the browser’s back/forward cache remounts the saved-game start screen rather than reviving old peers.

Opening any saved snapshot starts an **independent new live session**. It preserves stable player IDs and recent history, but does not restore connections, merge diverged games, or migrate an existing host.

## Shared rooms

1. Host: **Connect**, then **Open room**. Wait for the room link, then share it through a trusted channel. The link is a transient room credential, not a permanent room URL.
2. Guest: open the link, or open your own running app and paste the full link into **Room link** → **Join room**. Different local app origins and paths are fine.
3. The first participant to open the room becomes the priority participant. Additional players can only be created after a connection is established and the game is synchronized; offline edits to existing players remain supported.
4. Players choose or create an identity in the synchronized room. Roles (`gm` / `pj`) are labels, **not administrative permissions**. Remembered identities are convenience hints, not proof of identity.

A room closes when its participants leave. The host tab no longer owns all live state; if the first participant leaves, the next-earliest connected participant takes over conflict decisions and play continues.

### Testing peer connections locally

The app normally uses the public relay `wss://y-webrtc-eu.fly.dev`. For local development you can point the app at the bundled loopback relay instead:

```sh
npm run signal:start                                    # terminal 1 (127.0.0.1:4444)
VITE_GATHER_SIGNALING_URLS=ws://127.0.0.1:4444 npm run dev   # terminal 2
```

Open a second tab or browser and join the room link. The `ws://` override is honored **only in dev builds**; production builds require `wss://`.

When every configured signaling URL is loopback, the app also rewrites browsers' mDNS-obfuscated `.local` host candidates to `127.0.0.1` for that room. Some macOS/browser configurations cannot resolve those candidates across processes, which otherwise leaves ICE stuck at `checking`/`failed` even though signaling works. This fallback is dev-only and only valid because loopback signaling means every peer is on the same machine; it is **not** TURN and does not make remote peers or NAT traversal work.

If ICE still fails, check the browser's macOS Local Network and incoming-connections permissions; a firewall-blocked browser cannot receive WebRTC traffic. Firefox in particular may be blocked by the application firewall even when Chromium works.

If a connection fails, the table status now shows the transport error (for example, failed ICE or a room-password mismatch) instead of only “Waiting for connection.”

Alternatively, set it once in the browser so it persists across reloads:

```js
localStorage.setItem('gather:dev:signaling', 'ws://127.0.0.1:4444');
location.reload();
```

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

STUN discovers network addresses; it does **not** relay game data. The service sees discovery traffic, including your public address. Signaling uses the configured public WSS endpoint (`wss://y-webrtc-eu.fly.dev` by default). Signaling exchanges room metadata only; it does not store gameplay state. WebRTC offer/reply links contain network details and temporary connection credentials. Use trusted sharing channels. Long links can be truncated by messengers; selectable raw text/full-link paste is the fallback. Consumed incoming fragments are removed from the current address bar, but Gather cannot erase a messenger’s storage or promise control of browser history. SDP/ICE is never saved with a game or logged by the application.

No TURN relay is configured. Corporate firewalls, restrictive NAT, or incompatible network policies can make direct connections impossible. Same-machine tests do not prove connectivity between homes.

Games support **32 players**, **100 recent rolls**, and one die per request (d4/d6/d8/d10/d12/d20/d100; default d20). The host supports at most 31 remote peers / 8 unapproved peers. Incoming requests have a 20-message burst and 10/second refill per peer. Accepted roll IDs remain deduplicated for that connection; after 4,096 accepted requests, reconnect to roll more. A flooding peer is closed independently. Frames are bounded to 16 KiB, reassembled messages to 256 KiB / 128 chunks, 4 incomplete transfers / 10 seconds, and outgoing buffering to 1 MiB. JSON imports are capped at 1 MiB. History and causal operations have finite bounds; oversized backups are rejected.

## Compatibility

Current desktop Chrome, Firefox, Edge, and Safari are the compatibility targets. Feature detection explains unavailable APIs rather than crashing.

### Recorded run (2026-11-04, macOS, Playwright current)

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