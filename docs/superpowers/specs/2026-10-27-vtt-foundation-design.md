# Basic VTT: connections and saved games

Status: approved by the user. Independent builder-readiness review found no important gaps. No product implementation has started.

User feedback: the second screen (the game room) is acceptable for this milestone but will probably change substantially. Treat its layout as provisional and keep it replaceable without changing networking, persistence, or game rules.

## Intent

Build a small browser-based table for remote roleplaying, starting with the foundation rather than a full map-based VTT. A group can start or restore a game, connect browsers directly, identify its players, and see the same dice rolls. Games belong to the users and can be saved without an account or application backend.

The architecture must stay simple while leaving clear places for future features.

## Confirmed user requirements

- The entry screen offers a new game, importing a saved state file, and locally saved games.
- Players have names and roles: `gm` (game master) or `pj` (player).
- A new game allows creating players. A loaded game allows choosing existing players and remembering the choice in that browser where possible.
- An invitation link starts connecting another browser.
- The user explicitly accepted the necessary two-way invitation/reply exchange, and public STUN for network discovery, without a signaling server or gameplay relay.
- A simple dice utility broadcasts rolls to prove the connection works.
- Browser compatibility matters. Persistence and networking should be modular, not intertwined with the UI.

## Proposed implementation calls

These are builder recommendations, not additional user requirements. Approval of this document accepts them as the first-version defaults.

- TypeScript, Vite, semantic HTML and CSS, without a frontend framework. Native WebRTC data channels; no peer-networking service or SDK. Vitest for unit tests and Playwright for browser tests.
- Working title **Gather**. A quiet light interface with green accents, serif headings, visible status labels, and responsive cards.
- A host-and-spoke session: the browser that creates or opens a saved game hosts it. Each guest has one WebRTC connection to the host. The host forwards authoritative state to all guests. No guest-to-guest mesh.
- The creator becomes the first GM. Later player creation and existing-player claims require host approval. A guest may request either `gm` or `pj`; the host approves the requested name and role. Roles are labels in this milestone, not a granular permissions system. Being a GM does not automatically make a browser the session host.
- Roll one die at a time: d4, d6, d8, d10, d12, d20, or d100; d20 is the default. Keep the latest 100 results.
- Browser local storage is sufficient for the small JSON state in this milestone. IndexedDB, assets, and storage migrations beyond the initial schema are future work.

## Scope and non-goals

Included: creation, local save/continue, JSON import/export, player creation/reclaim, direct connections, connection diagnostics, shared dice history, and a testable modular foundation.

Not included: maps, tokens, character sheets, voice/video, chat, user accounts, cloud saves, a signaling service, a TURN relay, automatic host migration, seamless reconnection, guaranteed connectivity through restrictive networks, and installable-PWA/service-worker behavior. This is not a secure competitive dice platform or a replacement for host trust.

Do not silently contact a matchmaking service, upload games, use analytics, or claim that roles/remembered browser identities are authentication.

## Running and sharing the app

- Development and local use run through a documented npm command serving the web app on localhost. A production build is static files that can also be hosted over HTTPS. No backend is required.
- Each participant needs a running copy of the app, either their own localhost instance or the same static HTTPS deployment. `file://` is not a supported launch method.
- A link to the host's `localhost` is not a remotely accessible deployment. The UI and README must explain this. If the recipient's app address differs, they open their own copy and paste the invitation link/code there.
- WebRTC requires modern browser support and a secure context: HTTPS or localhost. Detect missing APIs and display a clear unsupported-environment explanation.

## User experience

### 1. Start or continue

The start screen offers:

1. **New game:** game name and creator name; generate stable game/player identifiers and create the initial GM.
2. **Load state file:** choose a JSON game file, validate it before changing current state, preview its name and player count, and choose an existing player for the hosting browser or create a new GM. Prefer this browser's remembered available identity. Never require that an old host or GM browser still exist.
3. **Continue local game:** list saved games by most recently saved time and open one using the same restore flow.

A restored game starts a new live session. It preserves game/player identifiers and roll history but has no live connections or occupied players. Only one live game is active per tab. Concurrent hosting of the same saved game in multiple tabs is unsupported and must not be presented as synchronized.

### 2. Game room

Show the game title, the local player's name and role, host/guest status, roster and online/offline state, shared roll history, a die selector, and Roll.

The host can create invitations, paste reply links, approve pending player requests, and download the latest game. Every browser can save/export its latest synchronized game snapshot, with a guest snapshot labeled as its last received state rather than a guarantee of live host state.

Persist changes automatically, but distinguish in-memory success from durable browser-save success. If storage is unavailable or full, keep the table usable, show a persistent warning, and offer file download.

Keep the room useful even when alone. A host can roll before inviting anyone. A guest cannot roll before its player claim is approved or after losing the host connection.

### 3. Invite/reply exchange

1. The host chooses **Invite a player**. Create a fresh invitation ID and peer connection, open an ordered reliable data channel, create/set the local offer, and wait for ICE gathering to complete before packaging it. Do not copy an incomplete offer.
2. Package an application protocol version, message kind, invitation ID, and the complete session description in a URL-fragment payload. Keep it out of query strings and never persist it with a game save. Provide copy-link and selectable plain-text code fallbacks.
3. The guest opens the invite link or pastes it into a join field in their own app. Validate it, create/set the remote offer, create/set the answer, wait for ICE gathering to complete, and show a reply link/code.
4. The host pastes the reply. Its invitation ID must identify a still-pending connection in this tab. The host applies the answer and waits for the data channel to open.
5. On channel open, exchange application protocol/session information and offer the guest the roster for choosing/creating an identity. Connection establishment and player approval are separate visible states.

Each player needs a separate invitation. An invitation is not a reusable room URL. Reply links never automatically start a new session if their original host connection is missing.

Pending invitations can be canceled and replaced. Reloading or closing either handshake tab invalidates its pending connection. Use a documented short timeout (builder may choose the exact value) and explicit gathering/awaiting-reply/connecting/connected/failed/canceled states; actionable timeout messages suggest generating a new invitation. Invalid, stale, oversized, reused, wrong-kind, or incompatible-version messages must not crash or overwrite an active game.

STUN is enabled with a small documented public-server configuration, with disclosure before starting a connection; it discovers addresses but does not relay game data. Do not silently add TURN. Explain that corporate firewalls and restrictive NAT can make a direct connection impossible. Show ICE/data-channel failure separately from malformed input.

Treat links as sensitive: exchanging them exposes network details and temporary connection credentials. Prefer trusted channels. Remove a consumed payload from the address bar using history replacement, without putting it into browser game storage or logs. Do not claim to control a user's browser history or chat service's own link storage.

### 4. Player creation and reclaim

- After connecting, the guest sees available saved players and a new-player option with a name and `gm`/`pj` selector. Occupied players are visibly unavailable.
- The browser stores a game-ID-to-player-ID hint separately from game state. Prefill a matching available player on return, but require confirmation and host approval. The hint is convenience, not proof of identity.
- A request is tied to the live peer connection. The host approves or rejects it. Only approval binds a player to that peer, persists a newly created player, and enables roll requests. Reject duplicate claims, even if they arrive concurrently. A player has at most one live owner; one peer has at most one player.
- Names are trimmed, nonempty, length-limited, rendered as text, and unique within a game ignoring case. Use stable IDs rather than names for references.
- A disconnected player remains in the saved roster but becomes available for reclaim after the old peer is released. Reconnection means a fresh invite/reply exchange and a fresh approval, not automatic ICE restart.
- Rejected requests can be corrected or retried while connected. No passwords, player secrets, or identity proofs are introduced in this milestone.

## Game model and synchronization

Versioned durable game state contains:

- schema version, stable game ID, game name, created/updated timestamps, and a monotonically increasing state revision;
- players with stable IDs, names, and `gm`/`pj` roles;
- the latest 100 rolls with stable roll IDs, player IDs, die sides, value, and timestamp.

Transient session state contains a new session ID, connection objects/states, pending invitations and approvals, peer-to-player bindings, and online presence. None of these belong in exported games. The local identity hint is a separate browser-only record. A restored session does not trust or recreate old connections.

The host is the sole writer of the live game. Guests send small typed requests; the host checks message structure, request type, connection binding, and allowed dice, then mutates state and broadcasts a snapshot. Guests cannot supply a trusted player ID, die result, full state replacement, or admin action. A GM on a guest browser follows the same transport rules.

Use full snapshots for this small first milestone, with session ID and state revision. Initial snapshots include the recent history so late joiners catch up. Process only snapshots from the expected host session and ignore old/duplicate revisions. Transport/UI extensions can later introduce events/deltas without changing durable game ownership.

Use a unique request ID for each roll, deduplicate requests per peer in the current session, and use Web Crypto for bounded host-generated die values. An accepted roll appears exactly once at the host and all connected, approved players, including the requester. The host is trusted and not cryptographically auditable.

Because all clients retain recent shared state, any participant may later open their latest local/file snapshot as a new host, but the app does not orchestrate a live host transfer or reconcile independently diverged games. Closing the host disconnects guests; they retain their last received state and can export it. Keep peer occupancy outside saved state.

## Persistence and import safety

- Keep storage and serialization behind a small module. Do not spread local-storage calls across rendering and networking code.
- Local storage indexes games by stable game ID and stores the schema-validated state. Browser clearing/private-mode limits can remove data; file export is the durable portable fallback.
- JSON export uses an explanatory `.json` filename and includes a schema version. No temporary credentials, SDP/ICE, connection objects, or browser identity hints.
- Import enforces a conservative file-size limit, supported schema version, shape/types/lengths/counts, unique player/roll IDs and names, valid roles and timestamps, valid die values, and valid roll-to-player references. Do not partially import or overwrite saved state on error.
- For an existing saved game ID, explicitly confirm replacement before overwriting. Imported state remains a new live session regardless of its prior timestamps/revision.
- Corrupt browser records must produce recoverable warnings rather than preventing access to the start screen or other valid saves.

## Module boundaries

A small structure, not a plugin framework:

- `src/game/`: durable types, validation, pure operations for players/rolls, and game serialization rules.
- `src/storage/`: browser-save repository, file import/export, and local identity hints.
- `src/network/`: signaling codec, WebRTC lifecycle, and transport-level message validation/events. No DOM rendering or game mutation here.
- `src/session/`: host/guest orchestration, claims/presence, request checks, revisions, and snapshot fan-out using game and transport interfaces.
- `src/ui/`: start/restore/room/invite/join views and accessible feedback. Wire the modules from one application entry point.

Avoid a global event bus, dependency-injection framework, speculative plugin API, or generic state-management layer. Prefer explicit small interfaces and callback subscriptions. The builder chooses exact filenames and rendering helpers.

## Compatibility, accessibility, and resilience

- Target current stable desktop Chrome, Firefox, Edge, and Safari. Use standardized `RTCPeerConnection`, reliable RTC data channels, local storage, Blob/file inputs, TextEncoder/TextDecoder, and Web Crypto. Feature-detect requirements; do not browser-sniff.
- Avoid relying on native CompressionStream or experimental APIs for signaling. Base64url-encoded JSON with plain-code paste fallback is sufficient. Signaling URLs can be long and some messengers truncate them; document that limitation rather than promising every sharing service will preserve them.
- Use secure-context clipboard when available, with selectable text fallback. Every action must be keyboard accessible; inputs have labels, focus is visible, async status/errors are announced, and presence is not indicated by color alone.
- Validate all incoming network envelopes with byte/shape limits before use. Bound pending peers and per-peer request processing to avoid accidental resource exhaustion. Choose conservative limits and document them in implementation.
- Clean up channels, peer connections, timers, event subscriptions, and object URLs on cancellation, leave, failure, and page teardown. Mark disconnected participants without deleting their player history.

## Verification and acceptance

1. New-game creation yields an initial GM and a local save. Refresh/continue restores the same durable game without old live connections.
2. Valid exported state imports in another browser with stable players/history; corrupt, oversized, unsupported, or inconsistent files leave existing data untouched.
3. Two isolated browser contexts complete the actual offer/reply flow and exchange data over actual WebRTC channels, not a mocked networking service.
4. A third guest can connect through a separate invitation. Rolls from any approved participant appear once and identically in all three contexts; a newly connected guest receives recent history.
5. A restored game offers old identities, can suggest a locally remembered one, and lets the host approve one claimant while rejecting a concurrent duplicate. Unapproved peers cannot roll or replace state.
6. Disconnection, host shutdown, expired invites, wrong replies, missing clipboard support, and failed local storage show recoverable, honest UI states. Fresh invitation exchange allows a disconnected saved player to return.
7. Unit tests cover model/schema validation, storage failures, signaling codec and malformed input, claim conflicts, request deduplication, revision rules, and message authorization. Inject transport/clock/randomness for deterministic unit tests.
8. Run type checking, production build, unit tests, and browser tests. Exercise real WebRTC within each Playwright Chromium/Firefox/WebKit engine and cross-engine combinations where the local runner supports them. Record actual test coverage and any runner limitations. Edge and real Safari need a documented manual cross-browser smoke test; WebKit automation is not proof of shipping Safari behavior, and same-machine tests do not prove NAT traversal across homes.

## Mockup reference

`.superpowers/brainstorm/97561-1793101730/content/table-flow.html` shows the proposed start, room, connection, and player-reclaim screens. It is intentionally a throwaway visual mockup, not product code or a working network implementation. Exclude `.superpowers/` from future Git tracking.

## Left to the builder

Exact component/rendering helpers, spacing, filenames, conservative validation/rate/timeout values, public STUN endpoint configuration, and test fixtures. Keep these within the stated scope; do not add a backend, relay, new gameplay subsystem, authentication, or deployment service without asking.
