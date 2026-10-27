# Gather

A small, local-first virtual tabletop for your stories. Create or restore a game, connect browsers directly, choose approved player identities, and share dice rolls. No accounts, application backend, signaling service, analytics, or gameplay relay.

## Run

Use Node **22.12 or newer** and npm:

```sh
npm ci
npm run dev
```

Open **http://localhost:5173**. The dev server binds only to localhost with a strict port. `file://` is unsupported. Each remote participant must run their own copy or open a static HTTPS deployment; a link containing your `localhost` does not expose your computer to friends.

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

Changes save automatically in this browser, separately for each game. Private-mode restrictions, quota, clearing browser data, or switching origins can lose browser saves. A persistent warning distinguishes in-memory play from failed saving; download JSON for a portable backup. Leaving an unsaved table asks for confirmation. Concurrent hosting of the same game in multiple tabs is **unsupported** and not synchronized.

Opening any saved snapshot starts an **independent new live session**. It preserves stable player IDs and recent history, but does not restore connections, merge diverged games, or migrate an existing host.

## Connect each player (two-way exchange)

1. Host: **Invite a player**, read the privacy/network notice, then **Create invitation**. Wait until network discovery completes. Copy the invitation link using the button or select the text manually.
2. Guest: open the link, or open your own running app and paste the full link/raw code into **Invitation link or code** → **Open invitation**. Different local app origins and paths are fine. No discovery starts just by opening an incoming link.
3. Guest: read the notice, choose **Create reply**, and send the generated reply link/code to the host. Keep this tab open.
4. Host: paste into **Reply link or code** → **Connect player**. Wait for the data channel to open.
5. Guest: request an available saved player or a new name/GM-or-PJ role. Host: **Approve** or **Reject** the pending request. Only approval binds the identity and enables rolls.
6. Host: choose **Done** to dismiss the exchange. Repeat with a **new invitation for every guest**.

An invitation is not a permanent room URL. It expires after **10 minutes**; canceling or refreshing/closing its tab invalidates it. ICE gathering has a **30-second** timeout and post-answer connection has a **45-second** timeout. Wrong-tab, malformed, incompatible, and reused replies show errors. If discovery/connection fails, generate a fresh invitation; try a different network if necessary. After disconnect, the saved player becomes available for reclaim through a **new exchange and host approval**.

The host tab owns live game state and must remain open. Closing it disables guest rolls but leaves their latest state exportable. Roles (`gm` / `pj`) are labels, **not administrative permissions**. There is no authentication; remembered identities are convenience hints, not proof of identity. Trust the host and the people you exchange links with.

### Network privacy and limits

`src/network/config.ts` uses public Google STUN:

- `stun:stun.l.google.com:19302`
- `stun:stun1.l.google.com:19302`

STUN discovers network addresses; it does **not** relay game data. The service sees discovery traffic, including your public address. WebRTC offer/reply links contain network details and temporary connection credentials. Use trusted sharing channels. Long links can be truncated by messengers; selectable raw text/full-link paste is the fallback. Consumed incoming fragments are removed from the current address bar, but Gather cannot erase a messenger’s storage or promise control of browser history. SDP/ICE is never saved with a game or logged by the application.

No TURN relay is configured. Corporate firewalls, restrictive NAT, or incompatible network policies can make direct connections impossible. Same-machine tests do not prove connectivity between homes.

Games support **32 players**, **100 recent rolls**, and one die per request (d4/d6/d8/d10/d12/d20/d100; default d20). The host supports at most 31 remote peers / 8 unapproved peers. Incoming requests have a 20-message burst and 10/second refill per peer. Accepted roll IDs remain deduplicated for that connection; after 4,096 accepted requests, reconnect to roll more. A flooding peer is closed independently. Frames are bounded to 16 KiB, reassembled messages to 256 KiB / 128 chunks, 4 incomplete transfers / 10 seconds, and outgoing buffering to 1 MiB. JSON imports are capped at 1 MiB.

## Verification

Unit and DOM tests exercise schema boundaries, immutable operations, storage/file failures, signaling/framing bounds, native-peer lifecycle through an injected RTC factory, session authority/claims/replay handling, and accessible UI flows. End-to-end tests use **actual browser data channels**, public UI link exchange, and isolated contexts; there is no debug global or mocked WebRTC in acceptance tests.

Automated browser results are recorded in `docs/superpowers/plans/2026-10-27-vtt-foundation.md`. WebKit automation is **not proof of shipping Safari behavior**, and Chromium automation is not a claim that branded Edge was tested.

### Manual smoke tests (not yet run)

- Real **Safari ↔ Chrome**, in both host directions: exchange invitation/reply, approve two guests, roll once from each browser, verify matching history, disconnect/reclaim, close the host, export the retained state.
- Real **Edge ↔ Firefox**, in both host directions: repeat the same exchange and loss/reclaim checks.
- Two **different home networks**: repeat the exchange and rolls without relay; record both successful traversal and any actionable restrictive-network failure.
- Keyboard-only at desktop and narrow widths: tab through labels/actions, confirm visible focus and announcements, test clipboard denial/manual copy, cancel an import replacement, and export when browser storage is denied.

## Structure

- `src/game/`: durable schema, validation, immutable operations, unbiased Web Crypto dice.
- `src/storage/`: independent browser records, identity hints, validated JSON files.
- `src/network/`: UTF-8 signaling, bounded framing, native peer lifecycle; no game rules/DOM.
- `src/session/`: host/guest authority, approval, deduplication, presence and snapshots; no storage/DOM.
- `src/ui/`: replaceable views and application wiring. The game-room layout is intentionally provisional.

No maps, tokens, sheets, chat, voice/video, cloud saves, automatic host migration, seamless reconnection, or PWA are included in this foundation.
