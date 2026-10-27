# VTT Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first browser VTT with saved games, named GM/PJ players, serverless WebRTC invitation/reply connections, and synchronized dice rolls.

**Architecture:** A TypeScript static frontend has pure game operations, a browser-save repository, native WebRTC transport, host/guest session controllers, and replaceable DOM views. The host owns live state and fans snapshots out to connected guests; each peer connection is established by exchanging one offer and one answer. No application server or relay is involved.

**Tech Stack:** TypeScript, Vite, native browser APIs, Vitest with jsdom for view tests, Playwright for real browser/WebRTC tests. Node >=22.12; npm lockfile committed when Git is available.

**Spec:** `docs/superpowers/specs/2026-10-27-vtt-foundation-design.md` (approved).

## Global Constraints

- No signaling server or gameplay relay; public STUN for network discovery only.
- TypeScript, Vite, semantic HTML and CSS, without a frontend framework.
- Players have names and roles: `gm` (game master) or `pj` (player).
- Roll one die at a time: d4, d6, d8, d10, d12, d20, or d100; d20 is the default. Keep the latest 100 results.
- The host is the sole writer of the live game. Guests send small typed requests.
- Browser identity hints are convenience, not proof of identity. New/reclaimed players require host approval.
- Target current stable desktop Chrome, Firefox, Edge, and Safari. HTTPS or localhost; `file://` is unsupported.
- No accounts, maps, tokens, character sheets, voice/video, chat, cloud storage, TURN, host migration, seamless reconnection, or PWA work.
- The room screen is provisional: views must not contain networking, storage, or game rules.
- Workspace initially has no Git repository. Do not initialize one or create worktrees solely to satisfy commit steps. If Git becomes available, make a scoped commit after each verified task; otherwise record the verified checkpoint here.

## Review Focus

1. Reloaded or imported data is untrusted: reject unsupported versions, duplicate IDs/names, malformed references, and a conflicting save replacement without losing existing work (Tasks 1, 2, 5).
2. Networking races: cancellation during ICE gathering, a reply in the wrong host tab, already-open channels, and stale snapshots must not create ghost players or duplicate rolls (Tasks 3, 4, 6).
3. Guest input is not authority: spoofed roles, player IDs, game snapshots, duplicate roll requests, and simultaneous player claims must not bypass host decisions (Task 4).
4. Browser differences: limited clipboard/storage, Unicode/long signaling payloads, and small SCTP message limits need usable fallbacks rather than silent failure (Tasks 2, 3, 5, 6, 7).
5. Session loss is normal: host shutdown and player disconnect preserve exportable state, release occupancy, disable guest rolling, and permit a fresh manual connection (Tasks 4, 6, 7).

## File map and shared contracts

```text
package.json, package-lock.json, tsconfig.json, vite.config.ts
index.html, .gitignore, README.md, playwright.config.ts
src/main.ts                         # bootstrap only
src/game/{types,validation,model,random}.ts
src/storage/{repository,files}.ts
src/network/{config,signaling,framing,peer}.ts
src/session/{messages,types,host,guest}.ts
src/ui/{app,start,restore,room,connection,identity,dom,styles}.ts|css
tests/{game,storage,network,session,ui}/*.test.ts
tests/helpers/{game,transport,storage}.ts
tests/e2e/{games,connections,compatibility}.spec.ts
```

Use the following names consistently; types are exported from the owning module, not duplicated in views:

- `Role = 'gm' | 'pj'`; `DieSides = 4 | 6 | 8 | 10 | 12 | 20 | 100`.
- `Player = { id: string; name: string; role: Role }`.
- `Roll = { id: string; playerId: string; sides: DieSides; value: number; at: string }`.
- `Game = { schemaVersion: 1; id: string; name: string; createdAt: string; updatedAt: string; revision: number; players: Player[]; rolls: Roll[] }`.
- `Runtime = { id(): string; now(): string; die(sides: DieSides): number }` injects nondeterminism into pure model/session tests. Production uses Web Crypto and ISO timestamps.
- `TransportState = 'connecting' | 'open' | 'disconnected' | 'failed' | 'closed'`.
- `TransportEvent = {type:'state'; state:TransportState} | {type:'message'; value:unknown} | {type:'error'; message:string}`.
- `PeerTransport = { readonly id:string; readonly state:TransportState; send(value:unknown):void; subscribe(listener:(event:TransportEvent)=>void):()=>void; close():void }`.
- `Snapshot = { sessionId:string; sequence:number; game:Game; onlinePlayerIds:string[] }`. Snapshot sequence advances for presence changes as well as game changes; durable game revision advances only for game mutations.
- `Claim = {playerId:string} | {newPlayer:{name:string;role:Role}}`.
- `SessionView = {mode:'host'|'guest'; phase:'lobby'|'claiming'|'ready'|'disconnected'|'closed'; game:Game|null; lobby:Lobby|null; localPlayerId:string|null; onlinePlayerIds:string[]; pendingClaims:PendingClaim[]; error:string|null}`.
- `Lobby = {sessionId:string; gameId:string; gameName:string; players:Array<Player & {online:boolean}>}`; `PendingClaim = {peerId:string;requestId:string;claim:Claim}`.
- `SessionController` exposes `getView():SessionView`, `subscribe(listener:()=>void):()=>void`, `roll(sides:DieSides):void`, and `close():void`. Hosts/guests add their role-specific methods in Task 4.

### Task 1: Validated game model and runnable project

**Files:** Create root package/build/test configuration, `.gitignore`, `index.html`, `src/main.ts`, `src/game/{types,validation,model,random}.ts`, `tests/game/{model,validation,random}.test.ts`, `tests/helpers/game.ts`.

**Interfaces:** Produces the game types above, `validateGame(value:unknown):Game`, `createGame(name:string,creatorName:string,runtime:Runtime):Game`, `addPlayer(game:Game,name:string,role:Role,runtime:Runtime):{game:Game;player:Player}`, `recordRoll(game:Game,playerId:string,sides:DieSides,runtime:Runtime):Game`, `rollDie(sides:DieSides):number`. Validation throws `ValidationError` with a human-readable message.

- [x] **Step 1: Create the minimal toolchain and failing tests.** Add npm scripts `dev`, `build` (`tsc --noEmit && vite build`), `typecheck`, `test` (`vitest run`), and `test:e2e` (`playwright test`). Install Vite/TypeScript/Vitest and create the lockfile. Ignore `node_modules/`, `dist/`, `.superpowers/`, Playwright output, and coverage. Bind local dev to localhost:5173 with strict port. Write tests before model implementations:

```ts
it('creates an immutable game with one GM', () => {
  const game = createGame('  Lantern Road  ', ' Alex ', runtime());
  expect(game).toMatchObject({schemaVersion: 1, name: 'Lantern Road', revision: 0});
  expect(game.players).toMatchObject([{name: 'Alex', role: 'gm'}]);
  expect(game.rolls).toEqual([]);
});
it('retains the latest 100 rolls and increments revision', () => {
  let game = fixtureGame();
  const original = structuredClone(game);
  for (let n = 0; n < 101; n++) game = recordRoll(game, game.players[0].id, 20, runtime());
  expect(game.rolls).toHaveLength(100);
  expect(game.revision).toBe(original.revision + 101);
  expect(original.rolls).toEqual([]);
});
```

Also test trimmed case-insensitive duplicate names, unknown players, invalid dice/results, ID/reference duplicates, invalid timestamps, noninteger revisions, and schema versions. Pin limits: game names 1–100 characters, player names 1–64, IDs 1–64, 32 players, 100 rolls. String lengths use Unicode code points. Reject extra structural fields so imported credentials/unknown objects cannot silently propagate.

- [x] **Step 2: Run `npm test -- tests/game`; confirm failure is missing model exports, not broken test configuration.**
- [x] **Step 3: Implement the exported contracts.** Validate and copy imported records; do not retain mutable input references. Keep mutations immutable. Use rejection sampling over `crypto.getRandomValues(new Uint32Array(1))` for unbiased die values, with an injectable random-word provider in random-unit tests. Generate a new UUID for each game/player/roll. Initial GM creation keeps revision 0; later additions/rolls increment once.
- [x] **Step 4: Run `npm test -- tests/game`, `npm run typecheck`, and `npm run build`; all must pass.**
- [x] **Step 5: Record a verified Task 1 checkpoint; commit only if this directory is then a Git repository.**

### Task 2: Local repository, identity hints, and safe portable files

**Files:** Create `src/storage/{repository,files}.ts`, `tests/storage/{repository,files}.test.ts`, `tests/helpers/storage.ts`.

**Interfaces:** Consumes `Game`, `validateGame`. Produces `createRepository(storage:Storage):GameRepository`, where `list():{games:Game[];warnings:string[]}`, `get(id:string):Game|null`, `save(game:Game):SaveResult`, `rememberPlayer(gameId:string,playerId:string):SaveResult`, and `rememberedPlayer(gameId:string):string|null`; `SaveResult = {ok:true}|{ok:false;message:string}`. File API: `parseGameFile(file:File):Promise<Game>`, `serializeGame(game:Game):string`, and `downloadGame(game:Game):void`.

- [x] **Step 1: Write failing tests** named `round trips independent games and identity hints`, `survives one corrupt record and reports it`, `returns save warning on denied storage or quota`, `does not export identity or connection state`, and `rejects invalid files without repository writes`. Assert a save never throws on storage denial, malformed JSON does not hide other games, and a valid Unicode game round-trips with exact IDs/history. Assert files over 1 MiB are rejected before `text()` is read; unsupported schema versions and invalid references reject. Verify object-URL revocation for downloads.
- [x] **Step 2: Run `npm test -- tests/storage`; confirm these fail for absent storage/file APIs.**
- [x] **Step 3: Implement the interfaces.** Use individual `gather:game:<id>` records, not an all-games blob/index that can erase unrelated saves. Scan prefixed keys, validate each independently, sort by `updatedAt`, and catch property access as well as get/set errors. Store identity hints under `gather:identity:<gameId>`. Serialize only the validated durable schema. File parsing is side-effect-free; the UI owns replacement confirmation. Use Blob + temporary anchor + eventual object-URL revocation for downloads.
- [x] **Step 4: Run `npm test -- tests/storage tests/game` and `npm run typecheck`; all must pass.**
- [x] **Step 5: Record the Task 2 checkpoint; make a scoped commit if Git is available.**

### Task 3: Serverless signaling, bounded framing, and WebRTC lifecycle

**Files:** Create `src/network/{config,signaling,framing,peer}.ts`, `tests/network/{signaling,framing,peer}.test.ts`.

**Interfaces:** Produces `Signal = {version:1;kind:'offer'|'answer';invitationId:string;description:{type:'offer'|'answer';sdp:string}}`, `encodeSignal(signal:Signal):string`, `decodeSignal(linkOrCode:string):Signal`, and `signalLink(signal:Signal,baseUrl:string):string` (replace the base fragment; use `#invite=` or `#reply=`). `PeerOptions = {signal?:AbortSignal;rtcFactory?:()=>RTCPeerConnection}`. `createInvitation(options?:PeerOptions):Promise<PendingInvitation>` returns `{invitationId:string;offer:Signal;transport:PeerTransport;accept(answer:Signal):Promise<void>;cancel():void}`; `answerInvitation(offer:Signal,options?:PeerOptions):Promise<{reply:Signal;transport:PeerTransport}>`.

- [x] **Step 1: Write failing codec/framing tests.** Assert base64url UTF-8 round-trips, full-link/plain-code paste works, unsupported versions/wrong kinds/oversize payloads reject, and fragments replace old fragments without leaking into queries. `encodeFrames(value:unknown):string[]` and `createAssembler(now:()=>number)` / `accept(frame:string):unknown|undefined` must reassemble a large Unicode snapshot and reject duplicate/inconsistent chunks, oversize messages, too many in-flight transfers, and timed-out fragments. Frame serialized messages into chunks of at most 3,000 UTF-16 code units; each encoded frame must be <=16 KiB UTF-8. Limit a reconstructed message to 256 KiB, 128 frames, 4 incomplete transfers, and 10 seconds per transfer.
- [x] **Step 2: Run `npm test -- tests/network`; confirm absent APIs fail.**
- [x] **Step 3: Implement codecs and the bounded assembler.** Validate before allocating/parsing further. Cap encoded signaling input at 128 KiB and decoded SDP at 64 KiB; accept only matching description/message kinds. Include generated transfer IDs, indices, and counts in frames. Do not trust remote frame counts/IDs, and clear the assembler on peer cleanup.
- [x] **Step 4: Add failing lifecycle tests** for waiting until complete ICE gathering, already-complete gathering, cancellation during gathering, timeout, applying an answer to the wrong invitation, second-use answers, a data-channel error, duplicate close calls, and all listeners/timers being removed. Use an injected fake `RTCPeerConnection`; do not replace real-browser acceptance tests with it.
- [x] **Step 5: Run `npm test -- tests/network/peer.test.ts`; confirm lifecycle tests fail.**
- [x] **Step 6: Implement native peer lifecycle behind `PeerTransport`.** Use `stun:stun.l.google.com:19302` and `stun:stun1.l.google.com:19302` in a documented configuration module, with no TURN. Use one ordered reliable `gather-v1` data channel, `iceGatheringState` plus events, a 30-second gather timeout, a 10-minute pending-invitation timeout, and a 45-second post-answer connection timeout. Expose gathering/awaiting-reply progress through the connection UI's operation state. Guests register `datachannel` before setting the offer. Keep the invitation's consumed flag and peer state in memory only. Cap send buffering at 1 MiB; report backpressure/failure rather than silently dropping a snapshot. Send/read only validated text frames, and handle already-open channels when subscribers attach. Close and detach everything on abort/failure/cancel.
- [x] **Step 7: Run `npm test -- tests/network`, `npm run typecheck`, and `npm run build`; all must pass.**
- [x] **Step 8: Record the Task 3 checkpoint; make a scoped commit if Git is available.**

### Task 4: Host/guest sessions, approved identities, and shared dice

**Files:** Create `src/session/{messages,types,host,guest}.ts`, `tests/session/{messages,host,guest,integration}.test.ts`, `tests/helpers/transport.ts`.

**Interfaces:** Consumes game operations and `PeerTransport`. `createHostSession(game:Game,localPlayerId:string,runtime:Runtime):HostSession`; `HostSession extends SessionController` with `attach(transport:PeerTransport):void`, `approve(peerId:string,requestId:string):void`, and `reject(peerId:string,requestId:string):void`. `createGuestSession(transport:PeerTransport,runtime:Runtime):GuestSession`; `GuestSession extends SessionController` with `claim(value:Claim):void`.

Message union, validated by `parseMessage(value:unknown):Message`: `hello {version:1}`, `lobby {lobby:Lobby}`, `claim {requestId:string;claim:Claim}`, `claim-result {requestId:string;status:'approved'|'rejected';playerId?:string;reason?:string}`, `roll-request {requestId:string;sides:DieSides}`, `snapshot {snapshot:Snapshot}`, and `error {message:string}`. Each has a literal `type` discriminator. Guests accept only host-side variants and hosts only guest-side variants. A lobby carries no roll history; approved peers receive snapshots. Validate all IDs, names, versions, counts and nested game state at this boundary.

- [x] **Step 1: Write failing session tests** using paired fake transports and deterministic runtime. Assert two guests plus host see identical results exactly once; a late joiner gets recent history; unapproved peers cannot roll; guest-supplied state/player identity/results are rejected; duplicate requests do not roll twice; concurrent claims permit only one approval; rejection leaves game unchanged; and browser role labels do not grant host operations. Test snapshot sequences across presence-only changes, out-of-order sequences, stale game revisions, and a changed session ID.
- [x] **Step 2: Run `npm test -- tests/session`; confirm missing controllers cause failures.**
- [x] **Step 3: Implement `parseMessage`, host and guest controllers.** Send hello immediately when an attached transport is already open, otherwise on opening. A guest answers a host hello with its own hello; a host answers a compatible guest hello with a lobby, not another hello. This handshake is idempotent and works in either attachment order even if the first hello was sent before a listener existed; add a test for each order. Derive sender identity from the approved peer binding, never a request field. Validate ownership again at approval time. Add a new player only on approval; a refused request creates no orphan player. Host-local rolls use the same validated mutation path as guest requests. Broadcast full snapshots and lobby occupancy updates after accepted changes; track independent monotonically increasing snapshot sequence numbers. Guests remember the first lobby session and game IDs, reject unexpected hosts, and ignore old snapshots. Expose immutable view data/subscriptions; no DOM or storage access here.
- [x] **Step 4: Add failing resource/loss tests.** Assert disconnect releases ownership while retaining the roster, host closure leaves guest game exportable and rolls disabled, an already-open-channel handshake works, a stale closed-peer request is ignored, and close is idempotent. Assert max 31 remote peers, 8 unapproved peers, and a per-peer token bucket of 20 messages burst / 10 messages per second. Keep accepted request IDs for that peer's whole connection; cap them at 4,096 and reject further rolls with a reconnect instruction rather than evicting IDs and allowing replay. Close a peer that exceeds message/resource limits without affecting others.
- [x] **Step 5: Run the added tests and confirm they fail before implementing cleanup and limits.**
- [x] **Step 6: Implement cleanup, request deduplication, and limits.** Unsubscribe before closing peers, clear occupancy and pending claims on close, and invalidate stale pending approvals. Each guest request has a new UUID; repeat IDs never generate new results. Snapshot presence changes must still apply when durable game revision is unchanged. Check the game still fits validated limits before accepting a new player.
- [x] **Step 7: Run `npm test`, `npm run typecheck`, and `npm run build`; all must pass.**
- [x] **Step 8: Record the Task 4 checkpoint; make a scoped commit if Git is available.**

### Task 5: Start, restore, and a replaceable room UI

**Files:** Create `src/ui/{app,start,restore,room,dom}.ts`, `src/ui/styles.css`, `tests/ui/{start,restore,room}.test.ts`; update `src/main.ts`, `index.html`, and test configuration. Add jsdom as a development dependency.

**Interfaces:** `mountApp(root:HTMLElement,dependencies:AppDependencies):{destroy():void}` coordinates repository/session/file adapters and views. Views take plain data plus callbacks and return `{update(data):void;destroy():void}`; export exact view-data/callback types beside each view. `createRoomView(root:HTMLElement,view:SessionView,actions:RoomActions):RoomView` exposes game title, roster, history, roll/export/leave controls; `RoomActions` callbacks are `roll(sides:DieSides)`, `download()`, `leave()`, `invite()`, `approve(peerId,requestId)`, and `reject(peerId,requestId)`. No view imports WebRTC or local storage.

- [x] **Step 1: Write failing DOM tests** for accessible new-game fields, showing independent local saves and corrupt-record warnings, restored-player selection with an available remembered identity, creating a new hosting GM, and invalid-import preservation. Test explicit replace/cancel when the imported game ID already exists. Assert names render as text (including `<img onerror=...>`), storage denial shows a durable warning plus download access, and a local-only host can roll before inviting anyone. Simulate an insecure context or missing `RTCPeerConnection`/Web Crypto and assert an actionable unsupported-environment explanation rather than a thrown startup error.
- [x] **Step 2: Run `npm test -- tests/ui`; confirm the missing views fail.**
- [x] **Step 3: Implement start/restore/room views and the app controller.** Use the approved mockup's typography/colors/layout as a starting point, without copying its fake network/roll behavior. Feature-detect secure context, `RTCPeerConnection`, Web Crypto, and TextEncoder/TextDecoder; explain HTTPS/localhost requirements and disable unavailable operations without crashing the start screen. Separate view creation from updates to preserve input focus and incomplete forms during session notifications. Parse/preview imports before confirmation and do not write/close a live session on validation failure. On a confirmed restore, create a new host session with the selected existing player or newly created GM. Persist valid changed game revisions and successful identity choices; do not rewrite saves on presence-only changes. Keep in-memory state and export available when saves fail. Show roster text labels, not just colored dots, and announce errors/status with appropriate live regions. Disable guest rolls outside ready/connected state. Do not add a room framework or speculative map area.
- [x] **Step 4: Add failing teardown/interaction tests** proving user input/focus survives updates, leaving with a failed save warns before discarding the active view, a snapshot from a guest is labeled last-received state, and re-mounting does not duplicate handlers/subscriptions.
- [x] **Step 5: Run the added tests, observe the failures, then implement the focused update/teardown fixes.**
- [x] **Step 6: Run `npm test`, `npm run typecheck`, and `npm run build`; all must pass.**
- [x] **Step 7: Record the Task 5 checkpoint; make a scoped commit if Git is available.**

### Task 6: Connection screens, player claims, and failure recovery

**Files:** Create `src/ui/{connection,identity}.ts`, `tests/ui/{connection,identity}.test.ts`; update `src/ui/app.ts` and `src/ui/room.ts` to mount the network/claim flows.

**Interfaces:** Consumes Task 3 invitation/answer APIs and Task 4 host/guest controllers. `createConnectionView(root:HTMLElement,actions:ConnectionActions):ConnectionView` represents generating/waiting/pasting/connecting/connected/failed/canceled with accessible status and copy/selectable-text controls. `createIdentityView(root:HTMLElement,lobby:Lobby,rememberedPlayerId:string|null,actions:{claim(value:Claim):void}):IdentityView` shows available/occupied players and a new-name/role form. The app owns pending invitation objects, not the room view.

- [x] **Step 1: Write failing DOM tests** for a unique invite per guest, STUN disclosure before any peer creation, selecting/copying a reply, clipboard rejection falling back to selectable text, pasting into a different local app address, malformed/wrong-tab/reused replies, cancel/regenerate, and the explicit expired-invite explanation after host refresh. Hash loading must not discard an active game without confirmation or automatically start network discovery before the user acts.
- [x] **Step 2: Run `npm test -- tests/ui/connection.test.ts tests/ui/identity.test.ts`; confirm failures.**
- [x] **Step 3: Implement the UI flows and wiring.** Use the complete local app origin/path to generate fragment links, explain localhost limitations beside the share controls, and accept full links or raw codes in every paste field. Inspect and validate an incoming fragment, then remove it via `history.replaceState`; retain the payload only in the pending UI flow. Show the privacy/network-discovery notice and require the guest's Create reply action before calling `answerInvitation`. Attach completed transports to the correct controller, with errors returned to the current step. Never log/store SDP or ICE credentials. Copy uses `navigator.clipboard` when available and always has a manual text fallback. Reject unexpected reply fragments without launching a new game.
- [x] **Step 4: Add failing claim/loss UI tests** for remembered-identity suggestions, occupied-player exclusion, approval/rejection/claim-race feedback, retrying rejected requests, presence updates, losing the host, exporting after loss, releasing a disconnected identity, and a fresh manual reconnection reclaiming that same player ID. Verify remembered hints update only after acceptance, and no UI says the hint authenticates a person.
- [x] **Step 5: Run the added tests to confirm failures, then implement claim/loss feedback and cleanup.** Pending operation handles and channels must be closed on cancel, leave, timeout and app destruction. On transient disconnect, disable guest roll controls; after terminal failure/close require a new exchange and approval. The host's game and other peers remain intact.
- [x] **Step 6: Run `npm test`, `npm run typecheck`, and `npm run build`; all must pass.**
- [x] **Step 7: Record the Task 6 checkpoint; make a scoped commit if Git is available.**

### Task 7: Real-browser interoperability and user documentation

**Files:** Create `playwright.config.ts`, `tests/e2e/{games,connections,compatibility}.spec.ts`, `README.md`; update `package.json`/lockfile with Playwright and any app code only to resolve reproduced failures.

**Interfaces:** Uses the public UI and actual browser data channels; no app-specific debug global or mocked WebRTC transport. A test helper drives host invitation copy-field → guest join paste → guest reply field → host reply paste. Clipboard access is not required by tests.

- [x] **Step 1: Install Playwright and its Chromium, Firefox, and WebKit engines. Write end-to-end tests before fixing integration failures.** Use a local Vite web server and isolated contexts. Configure one project per engine for the game/persistence tests. A separate serial interoperability suite explicitly launches browser types for Chromium↔Firefox and Chromium↔WebKit, plus same-engine Chromium/Firefox/WebKit. Do not mistake three projects independently running same-engine tests for mixed-engine coverage.
- [x] **Step 2: Run `npm run test:e2e`; capture real failures or environmental blockers.** Tests must cover create→refresh→restore; download→import into fresh context; canceled/invalid import preserving saves; real host + two approved guests; roll from each of three browsers appearing once everywhere; duplicate names and claims; late join history; disconnect/release/reclaim with fresh links; host closure disabling guest rolls while retaining export; and unsupported/denied API feedback. Use observable roster/history/status assertions rather than fixed sleeps. Real channel-open/data-exchange success is required even if local candidate gathering cannot reach external STUN.
- [ ] **Step 3: Resolve only reproduced integration defects and run targeted failing cases to green.** Use the systematic-debugging workflow if any failure is nontrivial. Do not introduce a signaling service or TURN as a test workaround. If a browser engine cannot be installed/run, preserve its tests and record the precise limitation; do not mark interoperability proven.
- [x] **Step 4: Write README run/save/connect instructions and manual cross-browser smoke tests.** Include npm setup/run/build commands, both invitation/reply steps per player, separate app origins/manual-code fallback, host-tab lifetime, roles vs host authority, browser-save loss risks, JSON replacement confirmation, STUN endpoints/privacy/no-relay disclosure, sensitive long links and messenger truncation, restrictive-network failures, and which engines/combinations were actually tested. Include real Safari↔Chrome, Edge↔Firefox, and two different home networks as manual checks; do not claim these passed without running them. Explain no accounts/authentication, reconnect-by-new-invite, 32-player/100-roll bounds, and that snapshots can be opened as a new independent session but are not merged or migrated live.
- [ ] **Step 5: Run the final verification gate:** `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:e2e`. Save exact pass counts and blockers below. Check `git diff --check` only if Git exists. Visually inspect keyboard/focus behavior, the light responsive layout, and status/error text at desktop and narrow widths.
- [x] **Step 6: Obtain one whole-change independent review using the requesting-code-review skill; fix verified issues with regression tests and rerun affected gates.** Review transport cleanup, authorization, import safety, claims, serialization bounds, and replaceability of the provisional room view.
- [ ] **Step 7: Record final verified checkpoint/commit if available, update this plan's checkboxes, and report actual coverage and known direct-network limitations without claiming unrun browsers pass.**

## Self-review

- Spec coverage: creation, local/file restore, restored identities, host approval, signaling, STUN disclosure, bounded reliable transport, dice, late-join snapshots, presence, errors, persistence failures, accessibility, and desktop-browser tests all map to Tasks 1–7.
- Interface consistency: the model is immutable; only sessions mutate live games; UI owns persistence and pending network operations; transport contains no game/UI dependencies. Snapshot sequences explicitly handle presence changes without a new durable revision.
- Review Focus: each listed failure class has explicit tests in its owning tasks. Real mixed-engine tests are separate from same-engine Playwright projects.
- Scope: no independently useful second product is bundled; these are layers of one milestone. The room remains a thin provisional view.
- Plan status: Tasks 1–6 implemented; independent review completed and five Important issues fixed. Task 7 remains blocked at the full real-browser acceptance gate (17 passed / 5 failed). User explicitly chose work on main in place.

## Execution record

- Design approved; second screen provisional.
- Tasks 1–6 checkpoints committed: `42e838d`, `7c350e6`, `f1c5f3d`, `f618a6c`, `86db0f9`, `2197dc3`.
- Task 7 initial test/docs checkpoint: `5d30220`. After review fixes, unit/DOM suite: **71 passed**. Typecheck/build: passed. npm audit: zero vulnerabilities.
- Stable full browser run (Playwright 1.64.1 on macOS): **17 passed / 5 failed**, exit 1. All 15 local/persistence/compatibility/keyboard cases passed across Chromium, Firefox, WebKit. Complete three-browser actual-channel scenarios passed for Chromium→WebKit and WebKit→Chromium, including approval, duplicate-name rejection, synchronized rolls, late history, fresh reclaim and host-loss export.
- Failing scenarios: Chromium↔Chromium and WebKit↔WebKit connection timeouts; Firefox↔Firefox and Firefox→Chromium offer-gathering failure; Chromium→Firefox reply-gathering failure. These remain unproven; no mocks, skipped tests, relay, or privacy flags were added to make acceptance green. An earlier interrupted run had 12 passed / 7 failed / 1 interrupted / 2 unrun; the stable run supersedes it.
- Native API diagnostics outside the app: Chromium ICE pair sent 81 requests with zero responses and remained connecting; Firefox generated zero candidates and was failed/new after 31 seconds. Evidence points to runner/network limitations, but does not prove all browser failures environmental. Retry the full suite on a network/runner permitting direct WebRTC. Do not mark Task 7 complete until it is green or the user explicitly accepts the limitation.
- Desktop and 390px screenshots inspected; keyboard roll retained focus and had no horizontal overflow. Real Safari, branded Edge and separate-home-network checks remain manual/unrun.
- Execution rulings: use the actual implementation plan linked by the requested design checklist; work on main per explicit user choice; make an initial docs/config commit because Git was unborn; use patched current Vitest to avoid old-major advisories. No backend, relay, or extra gameplay scope was added.
- Review fixes (each RED→GREEN, whole unit suite 71/71): explicit guest-save replacement protects divergent local copies (decline preserves existing save and leaves live state in memory/exportable); remount after persisted BFCache return; monotonic mutation timestamps under clock rollback; non-colliding empty restore sentinel; keyed approval rows preserve keyboard focus.
- Deferred review minors: the all-occupied saved-player action can appear enabled but does nothing; production code could use conventional block formatting. No identity can be claimed through the inactive action.
- Workspace and Task 7 ledger are retained because acceptance is blocked. No push, merge, or branch/worktree cleanup was performed.
