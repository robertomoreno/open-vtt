# Gather: local-first Yjs synchronization and shared room links

Status: independently builder-reviewed proposed design, incorporating the user's review decisions and awaiting full user approval. The reconciliation rules in `AGENTS.md` are approved; this complete migration design is not yet approved. No implementation or dependency installation is authorized by this document.

## Intent

Replace the manual WebRTC invitation/reply exchange with one reusable room link and Yjs synchronization through y-webrtc. People can work on a locally saved game before peers are reachable, connect later, and reconcile their changes without losing independent edits. Games remain in participants' browsers and downloadable files, never on a gameplay or storage server.

This is a synchronization and persistence redesign, not a signaling-only swap. The current host-only writer, guest request protocol, and approval screens cannot simply be wrapped in a Yjs document.

## Confirmed requirements

- The person who initializes or loads a game can open a shared room and send a link containing its room ID and game ID.
- Free public services may introduce peers and exchange handshake information, but must not receive game state or relay gameplay.
- Use Yjs CRDTs and y-webrtc. Reconcile connected participants' state before completing their player selection.
- A returning browser automatically uses its previous available player. A newcomer can choose an existing player or create one. “User” here does not introduce an account system.
- Local editing does not require an established connection. A connection can be initiated later by any participant.
- New players may only be added after a connection is established, not offline. This restriction does not prevent offline edits to existing players.
- Independent edits merge. Different PJ sheets, independent fields on one sheet, and distinct dice rolls are not conflicts.
- A genuine conflict is incompatible concurrent operations on a value, or a combination that violates a game invariant. A subsequent edit that has observed the earlier edit is not concurrent.
- For a genuine conflict, the first room participant's version wins, even when they authored neither competing change. Only the affected field or indivisible operation is resolved; unrelated edits survive. Explain the competing changes and the retained result in a warning.
- In particular, if Alice opens the room with “Old Castle” and Bob and Carol concurrently propose different names, retain Alice's “Old Castle.” Do not choose the earlier conflicting author instead.
- “First” means first to open the shared room, not first to open a local saved game. That person is also an editor, not just a referee.
- When the first participant leaves, the remaining people continue and the next-earliest connected participant takes over conflict decisions.
- A successor starts with their current validated version as the fallback; a fresh room starts with its opener's saved version. Do not resurrect an earlier participant's old fallback across a priority handover or new room.
- Keep the presentation in text. The user declined browser diagrams/mockups.

## Scope and anti-goals

Migrate the existing game creation/restore, roster, remembered player selection, direct connections, presence, dice, local saves, JSON import/export, and replaceable room UI.

PJ sheets are examples establishing reconciliation semantics, not an instruction to build a sheet editor. Do not add maps, tokens, chat, assets, audio/video, accounts, private-per-player data, a permission framework, a plugin framework, or a PWA.

Do not introduce a hosted Yjs document provider, y-websocket state server, cloud database, analytics, application backend, TURN relay, or paid service. Do not disguise signaling as game storage, use a whole-game winner, treat every differing snapshot as concurrent edits, or claim that a CRDT enforces game rules or authenticates players.

## Existing foundation and deliberate replacements

The TypeScript/Vite, semantic HTML/CSS, Vitest, and Playwright stack stays. `src/game/` already validates a version-1 game snapshot containing stable player IDs, up to 32 players, and the latest 100 rolls. `src/storage/` stores snapshots in localStorage and keeps identity hints separately. `src/session/` currently makes the host the sole writer; `src/ui/app.ts` coordinates manual signaling and approval.

This design deliberately replaces manual offer/reply links, host-only game writes, mandatory host approval, and host-loss shutdown. It preserves validation, stable IDs, bounded processing, usable in-memory play, explicit storage failures, and privacy boundaries. The old design and README describe current behavior until implementation updates them; do not prematurely describe the migration as working.

## Proposed implementation calls

These are recommendations made by the designer, not additional requirements already agreed by the user. Approval of this document accepts them as migration defaults.

1. Keep one active game per tab and one active player selection per participant. Preserve exclusive live occupancy within a synchronized reachable membership view and the existing `gm`/`pj` labels; neither is authentication. An offline local selection is not a confirmed live claim.
2. Use a normalized, causal operation model in Yjs rather than a single JSON value or a plain last-writer-wins field map. Retain competing values and the context needed to distinguish concurrent changes from unchanged or subsequent values.
3. Keep the network's shared Yjs document separate from the validated, durable local workspace. Persist only validated game operations/history and its valid materialized game, not a raw room document.
4. Store the last-good game snapshot and its encoded Yjs workspace history together in IndexedDB through a small repository. A native IndexedDB implementation is sufficient; y-indexeddb is not required merely because the network uses Yjs. Keep browser identity hints separate.
5. Export a versioned JSON backup containing a readable game snapshot and encoded causal history. Continue importing existing version-1 JSON files.
6. Make player selection/creation automatic when valid, without a host approval queue. Gate additional roster entries on an established peer connection, reconciled game, and reachable active priority participant. Competing occupancy and invalid/new duplicate names remain visible, recoverable session/game-rule errors.
7. Generate dice locally with the existing unbiased Web Crypto runtime and publish immutable, uniquely identified results. All participants are trusted collaborators; this is not an anti-cheat system.
8. Use a random room secret in the fragment link to enable y-webrtc signaling encryption. Explicitly configure public signaling and STUN-only ICE instead of trusting package defaults.
9. Preserve the existing new-game bootstrap that creates its initial GM/player. This initializes a valid game, rather than adding another player to an existing roster. After this initial seed, including when restoring/importing a game, creating additional players requires connection and synchronization. This bootstrap exception is a designer call, not a broader permission for offline player creation.

## Local workspace and room lifecycle

### Work before connecting

Creating or opening a saved game first produces a usable local workspace. Creating a game retains the existing creator/initial-GM bootstrap described above. Continuing or importing a game automatically selects this browser's remembered player if that player still exists; otherwise offer an existing player. Explain that creating an additional player becomes available after connecting and synchronizing; do not create a replacement GM offline. No identity hint is inferred from somebody else's exported file.

Supported local game actions continue without peers. Persist their causal history, not just the visible JSON snapshot. A future sheet feature must use the same local-first boundary, but no sheet UI is added here.

Opening a local save does not win priority in a room that has not been opened yet. When someone chooses to open/share a room, that browser creates a fresh room ID and in-memory secret and becomes the first room participant. A later incoming room link may attach the matching local workspace, including edits made before connecting.

### Share and join

- The room link has an application protocol version, random room ID, game ID, and random room secret in its URL fragment. It contains neither a game snapshot nor SDP/ICE.
- Anyone already in the room can share the same link. A second participant never has to produce or return a reply code.
- Display a short signaling/STUN/privacy notice before initiating discovery, with an explicit open/join action. Opening an incoming link can load its matching local game without silently starting discovery.
- Use the app's current origin/path for a share link. Preserve a paste-room-link entry for people running their own copy at a different origin; explain that `localhost` is not reachable by remote friends.
- The game ID identifies a local record and verifies the peer-supplied game. It is not a request to a server to load game data. With no local copy, wait for a peer to supply a valid game.
- If a matching local copy exists, preserve its pre-merge state and causal history before reconciling. Do not discard it merely because another copy is already online. A different active game requires an explicit leave confirmation.
- Remove a consumed fragment from the address bar. Keep the room descriptor only in the live controller; do not save it with games, backups, logs, or diagnostics.
- If no peer is reachable, keep an existing local workspace usable and describe the room as waiting, not synchronized. With no local game, report that loading needs a reachable participant. A game ID alone cannot recover a vanished game.

After the known active participants' initial contributions are reconciled, validate the resulting game and complete player selection. Automatically reclaim a remembered available player; otherwise show the roster and creation option. Recheck a local preconnection selection against the reconciled roster and current occupancy. An occupied/missing remembered player requires a choice, not silent impersonation.

### Online-only player additions

An established connection means a game peer is actually reachable, initial game reconciliation has completed, and the active priority participant can acknowledge a roster addition. A signaling WebSocket, `provider.connected`, an isolated local workspace, or an unfinished handshake is not sufficient. A participant who has lost all peers cannot add more players merely because they were connected earlier.

Disable/explain the new-player action while offline, connecting, or synchronizing. Recheck the condition when submitting and in the session/operation admission path, including if connectivity is lost while the form is open. Do not enqueue an authoritative offline roster-add operation and silently apply it later. Form text may remain a nonauthoritative draft until a connected submission.

The active priority participant serializes valid connected creation intents against the current roster, checks name/role/size rules, and admits the durable creation operation. This is a narrow roster-admission responsibility, not sole ownership of other participants' ordinary game edits or a human approval queue. A new participant without a player can connect and synchronize before submitting this intent.

The restriction applies when creating a new roster entry, not when replaying an already admitted historical operation or loading the existing players in a validated save. Imports and immutable shared history are still untrusted and validated; the supported-client online gate is not proof against somebody manually editing a JSON file in this no-authentication app.

Existing-player selection and supported local edits/rolls remain usable offline. That local selection is a convenience, not a new globally exclusive live claim. Recheck ownership when synchronized participation resumes. A connected subgroup may still have unreachable participants elsewhere; online creation does not magically prove global name uniqueness or exclusive ownership across a network partition. Reconcile such collisions using the normal invariant/conflict rules.

### Leaving, rejoining, and room lifetime

The room is independent of its opener's data channel. Peers that can still reach one another continue after the opener leaves, retaining the same shared link and game.

Room membership and entry order are transient. The opener is assigned the first position; later admissions receive a logical order from the active priority participant. Do not order people by client wall clocks, stored identity hints, or Yjs client IDs. Use deterministic participant-ID tie-breaking only for simultaneous or partition-ambiguous admissions, not as ordinary first-entrant priority.

A participant that explicitly leaves or expires from membership loses its position. A later rejoin is a new admission; it does not displace a successor by resurrecting an old position. The builder chooses a documented disconnect grace period and deterministic convergence of membership views. A temporary transport interruption within that grace period need not create a new admission.

On priority handover, freeze the successor's current validated game/frontier as the start of their new priority tenure. A newly opened room likewise takes its opener's current saved game/frontier. These boundaries reset the starting conflict fallback even for delayed branches that began before the boundary. They do not restore old membership from a backup or erase the history needed to recognize those branches.

During a network partition, a browser cannot know the absolute real-world order or distinguish a remote failure from isolation. Each reachable group can continue locally and label its state as not synchronized with unreachable participants. Once communication returns, converge on one deterministic membership/priority view and reconcile provisional work; do not promise globally serialized decisions during a partition. Entry-order ambiguity must be surfaced rather than hidden behind wall-clock guesses.

If everybody leaves, no public server retains the game or keeps a recoverable live room. Reopening a saved game can create a new room/link. An old link waits for an actual participant and must not silently fabricate state or claim to resume a vanished room. Refresh/teardown closes the current room participation; a local save remains available independently.

## Shared game model and causal reconciliation

### Why ordinary Y.Map assignments are insufficient

Yjs converges, but default concurrent assignment selection is not this product's first-participant rule and does not provide complete losing-value warnings. Two independently reconstructed JSON objects also lack enough history to tell an unchanged value from an offline edit. Neither shortcut is acceptable.

Use Yjs shared maps/collections with stable domain IDs and a small explicit causal change representation. For the existing model, that representation covers game metadata, player records/fields, and immutable roll events; it is not an arbitrary schema or plugin engine.

Each mutable-field or indivisible-record operation retains an immutable operation ID, affected entity/field, proposed value, and causal parent/frontier context. Distinct operations cannot overwrite one another merely by assigning the same map key. Retain competing candidates until a causal resolution accounts for them. Exact duplicate operations are idempotent. Validate stable references, field types, allowed operations, dependency counts, and history limits.

Immutable rolls are merged by stable roll ID, with identical replayed results deduplicated. A stable, deterministic ordering and latest-100 projection preserve the existing history limit; concurrent distinct rolls are not conflicts. A repeated ID with different content is invalid/incompatible, not a second result. Timestamps are display data, not conflict authority or proof of causality. The legacy snapshot revision is not a global freshness gate; use causal history/state vectors.

### Reconciliation contract

1. Freeze each participant's validated pre-reconciliation contribution and causal frontier before importing peers' contributions into its accepted state. Network staging may already be receiving Yjs updates; that is not permission to overwrite the local baseline.
2. Validate and merge candidate operations. Missing causal dependencies wait in a bounded pending set rather than being mistaken for either valid final state or a conflict.
3. Project compatible operations. Independent fields/records and causally later changes apply normally. Equal concurrent results need no conflict warning.
4. Find only genuinely incompatible concurrent values and the smallest invariant-violating operation components. A mere difference from the priority participant's unchanged copy does not make one offline edit conflicting.
5. For each such component, retain the first active room participant's relevant pre-reconciliation version, including their own local edits. Their unchanged value or record absence can be the winner; they need not be an author of either competing proposal. Never substitute the earliest competing author's value.
6. Publish an explicit causal resolution that accounts for all competing heads. Preserve unrelated operations, validate the complete materialized game, then commit it to local accepted state. Show the same resolution details on affected peers.
7. A subsequent edit that has received this resolution can replace the result normally. Do not repeatedly warn for the same resolved set or make priority into permanent field ownership.

For live traffic within one priority tenure, the causal base/checkpoint preceding the competing branches determines the frozen first-participant fallback, but never before that tenure's starting checkpoint. If the branches began before a handover/new-room boundary, use the new priority participant's tenure-start value instead of resurrecting the historical fallback. For branches within the tenure, do not let delivery order change the winner by first copying Bob's candidate into Alice's fallback before Carol's concurrent candidate arrives. Retain enough checkpoints/first-participant contributions to reproduce the “Old Castle” outcome for either delivery order within Alice's tenure. A local edit by Alice is itself part of her contribution and can supply the priority value. Backups preserve causal game history and completed resolutions, not active room membership; opening a new room from a backup deliberately starts a new tenure.

For example, Alice starts at Old, Bob's sole Red rename is accepted, Dave receives Red, and Alice leaves. When Dave takes over, Red is his tenure-start fallback. A delayed Blue branch concurrent with Bob's original Red therefore resolves to Dave's Red, not Alice's Old. Opening a fresh room from a saved Red version has the same reset behavior.

An operation that descends from only one competing branch, without observing the published resolution, extends that original conflict; arriving after the resolution does not turn it into a causally subsequent replacement. For example, Dave's “Green Castle” edit based only on Bob's “Red Castle” remains concurrent with Carol's “Blue Castle.” Within the same priority tenure, both all-at-once delivery and delivery after an initial Red/Blue resolution retain Alice's original fallback. Extend the resolution to account for the newly received descendant using the same fallback, retaining the existing causal heads/recovery evidence. Only a new edit that observes the resolution of the relevant conflict can replace that result normally. Do not compare a delayed branch to a resolution as if their delivery order established a new shared base.

The builder chooses the smallest checkpoint/causal-frontier representation that implements this contract. Do not implement wall-clock batching as a substitute for causal conflict detection or discard evidence before delayed/offline changes have been reconciled.

### Invariants and unresolved data

Keep the existing bounds, valid player/roll references, unique player IDs/names, supported roles/dice, and valid die results. Live player occupancy remains session state, not durable game state.

For a game invariant collision, prefer the priority participant's valid version of the affected records/operation component. If their baseline has neither of two incompatible new records, retaining that baseline can leave both proposals unapplied. Keep those proposals recoverable with an explanation and a retry path, rather than inventing a winner, renaming players silently, creating orphaned rolls, or replacing the full game. Dependent changes belong to that affected component; unrelated valid changes still apply.

Connected player-claim intents can be serialized against the active priority participant's valid occupancy view without a human approval queue. Within one reconciled reachable membership view, never grant two peers the same player. When the current view cannot safely grant a claim, keep it pending/rejected with a choice/retry message. Disconnected/local selections are unconfirmed, not globally exclusive live ownership, and an isolated client cannot grant new live claims. After partition healing, reconcile conflicting live views before confirming renewed claims; a losing claimant chooses again while compatible game edits/rolls remain. Do not use remembered browser identity as an override or pretend the online-only roster-addition gate guarantees absolute global exclusivity across disconnected groups.

### Conflict warnings and recovery

Warnings identify the affected player/entity and field or violated rule, the competing values/operations, the retained value, and the first-participant rule that selected it. Escape/render values as text. Do not expose room secrets, SDP/ICE, network addresses, or raw signaling payloads.

Provide a recoverable pre-reconciliation copy for a joining participant before overwriting their accepted save. Keep losing candidates in bounded history/recovery data until the user can inspect/export them; a warning must not be the only trace of a discarded offline change. Storage failure leaves the recovery copy in memory with a download action and a clear warning. This is local recovery, not cloud versioning or an unbounded undo product.

## Validated workspace, network staging, and persistence

The y-webrtc provider synchronizes a transient room document. It can contain candidate game operations and transient session coordination. It is not the application's accepted game or its persistence record. Upstream y-webrtc applies remote Yjs updates before application observers run; do not pretend a post-update validator has rejected the raw update before it entered this staging document.

The session/domain boundary validates staged operations and projects a valid game before admitting changes into a separate durable workspace document. Copy validated semantic operations using stable operation IDs and their causal context; do not rebuild either side from the latest plain snapshot on every update. The two documents may have different internal Yjs struct IDs, so native state vectors are meaningful only within their own document; stable semantic operation identities and parents must survive this bridge.

Only the durable workspace's validated game history and last-good snapshot are saved/exported. Awareness, active membership/order, leases, provider objects, credentials, and browser identity hints never enter it. Persist explicit game resolutions without embedding live room credentials or restoring old occupancy.

The repository atomically stores a last-good readable snapshot and the encoded workspace state for the same causal frontier in IndexedDB. A localStorage recent-game index may be a cache, not a second competing source of truth. If an IndexedDB transaction or index update fails, retain usable in-memory state, explain which save failed, and keep downloads available.

Migrate existing valid localStorage games lazily on opening. Leave the old record intact until the new durable record is confirmed written. Corrupt or denied storage must not block other saves or startup. Do not require an IndexedDB feature to create/play an in-memory game.

## Download format, import, and legacy ambiguity

The proposed version-2 JSON backup has an explicit Gather format/version, a readable validated game snapshot, a causal model version, and a base64-encoded durable Yjs update. Its history includes the context required for offline reconciliation. It excludes all live room/session data and identity hints. “Download game” remains available to every participant, including while disconnected or saving has failed, with an honest last-local-state label.

Import validates the outer format/version and byte limits before decoding. Load history into an isolated document, validate its operation graph and projection, and require that its projected game agrees with the embedded readable snapshot. Reject malformed, mismatched, unsupported, oversized, or inconsistent backups without partially replacing any save. Confirm replacement for an existing game ID; cancellation preserves the existing record. Do not trust an encoded Yjs update merely because its JSON wrapper is valid.

Existing version-1 JSON files remain importable as validated snapshots that seed a new causal baseline. If two copies share history, use it for proper offline merging. If only diverged legacy snapshots exist, there is no evidence that can distinguish an unchanged field, an edit, or a deletion reliably. Do not fabricate that evidence or call all differences proven concurrent edits.

For this legacy/no-common-history case, merge demonstrably compatible additions by stable ID, do not infer deletion from absence, and use the priority participant's value for ambiguous differing fields/invariant components. Clearly label this as limited-history reconciliation, preserve the pre-merge copy, and show the affected fields. This fallback does not weaken the requirement to merge a known single offline edit correctly for new history-preserving saves.

History cannot grow without bound. Keep semantic/encoded-size budgets and bounded pending/recovery data. Compaction must retain sufficient causal summaries to handle delayed/offline edits and stable event deduplication; it must not silently reseed a document from plain JSON. If a safe bound is reached, preserve the last valid state and provide an actionable save/recovery warning rather than dropping unrelated changes or claiming a successful merge. Exact budgets/compaction mechanics are builder calls to verify with long-running and old-peer tests.

## Signaling, privacy, and transport limits

Use an explicit configuration of free public y-webrtc-compatible WebSocket signaling endpoints. Use an opaque random room topic, not a game name or game-state payload. Configure the fragment secret as the provider password so SDP/ICE announcements are encrypted over signaling. The service still sees connection metadata, IP addresses, topic subscriptions, and traffic; it is not anonymous or authenticated hosting. Link possession grants collaboration access, so share it through trusted channels.

Keep public STUN for address discovery, explicitly configured through y-webrtc's peer options. No TURN entries, relay fallback, game upload, or alternate transport to a state server are allowed. The signaling socket may remain subscribed for later introductions; “handshake only” describes the data it carries, not a requirement to disconnect it after the first connection. Loss of signaling should not close already-working direct data channels; new discovery can fail independently.

Use actual peer/data-channel and validated-session progress for connection labels. Upstream `provider.connected` means discovery is enabled, not that any peer is connected, and `synced` is not proof every room participant is known or that a valid game has loaded. Same-origin BroadcastChannel is an optional local optimization, not evidence that cross-browser WebRTC worked.

Preserve bounded network processing. A provider adapter must enforce peer/channel counts, encoded-message limits, outgoing buffering, pending-transfer budgets/timeouts, and application operation/awareness limits. Reuse the existing framing approach where needed for large binary sync messages. y-webrtc does not supply the old transport's bounds or pre-apply validation by default; implement these at the native RTC/runtime/channel boundary using documented provider/simple-peer options, without replacing the real transport in acceptance tests or silently depending on private provider internals. Surface adapter failures even if the upstream provider swallows a send exception.

Retain the 32-player game bound; target at most 32 admitted participants, with up to 31 direct remote connections per browser and bounded pending admissions. Do not retain y-webrtc's randomized default connection ceiling without relating it to this room size. Feature-detect required RTC, WebSocket, Web Crypto/subtle crypto, encoding, and secure-context support. Missing storage is recoverable; missing connection APIs do not disable local play where local APIs are available.

There is a technical acceptance gate before retiring the old transport: demonstrate real-channel operation, binary framing, teardown, input/resource bounds, and the staging/validated-workspace boundary with the chosen y-webrtc version and its documented hooks. If the stock provider cannot meet a boundary, stop and revise the adapter/design explicitly rather than weakening a privacy/validation rule, patching a vendored dependency silently, or declaring the gate passed.

### Public service availability is not yet established

Research on 2026-11-01 found y-webrtc 10.3.0's published source defaults to `wss://y-webrtc-eu.fly.dev`, while the README lists older endpoints. A Node WebSocket ping probe from this environment timed out after eight seconds on the former and failed to connect to `wss://signaling.yjs.dev`. No room, credentials, SDP, or game data were sent.

These are local observations, not proof of global outages. Select and verify a currently reachable, free public compatible endpoint before claiming automatic joining works. Document operator/privacy/availability limitations; public service uptime is not guaranteed. If none is available, retain the design/tests and report the blocker. Do not substitute self-hosting, a paid plan, a cloud document service, TURN, or mocked browser acceptance without a new user decision.

Automatic signaling also does not solve all NAT/firewall restrictions. Keep actionable, redacted failure details and rerun browser/network cases; old failures are not automatically fixed by a library change.

## Architecture and UI boundaries

- `src/game/`: schema/invariants, causal operations, deterministic projection, granular conflict detection/resolution, and existing random dice helpers. No RTC, DOM, or storage.
- `src/storage/`: asynchronous validated workspace repository, legacy migration, identity hints, atomic import/export/recovery. No network ownership decisions.
- `src/network/`: room-link codec, explicit signaling/STUN configuration, y-webrtc adapter, bounded native data-channel/runtime handling, and safe progress/failure events. No game rules or DOM.
- `src/session/`: local-to-room lifecycle, staging/workspace bridge, admitted membership/order/succession, reconciliation rounds/checkpoints, live player claims, presence, and subscriptions. No direct storage or DOM access.
- `src/ui/`: replace the manual exchange/approval screens with open/share/join, visible synchronization/waiting/offline states, remembered/existing/new player flow, conflict/recovery details, and persistent save warnings. Keep small explicit callbacks/interfaces and provisional room layout.
- `src/main.ts`: bootstrap only.

Keep keyboard access, labels, visible focus, and announced async statuses/errors. Preserve clipboard denial/manual link copying, canceled imports, stale/invalid links, duplicate-name/occupancy feedback, storage-denied downloads, and leave/teardown cleanup. No global event bus or new frontend state framework is needed.

At implementation time update README and the current-state portions of AGENTS.md together: the old no-signaling-service/host-only descriptions will no longer be accurate. Preserve dated history rather than rewriting the old foundation design as if it always used Yjs.

## Acceptance evidence required

### Deterministic unit/domain/storage tests

- Independent records/fields and concurrent distinct rolls merge without conflict warnings; identical operations/results are deduplicated.
- One offline field edit against an unchanged copy is preserved. A causally later overwrite is ordinary editing.
- Same-field concurrent values select the first room participant's value, including Alice's unchanged “Old Castle”; reverse/delayed delivery within a tenure does not select an earlier competing author instead. Backups preserve causal conflict detection and completed resolutions without restoring expired membership.
- A delayed descendant of one competing branch does not undo a resolution it never observed; all-at-once and split delivery of the same operations within a priority tenure converge on the same fallback.
- Alice's own local/offline edit participates in her priority contribution; unrelated edits survive every conflict case. Resolved heads do not produce endless repeated warnings.
- Cross-field/record invariant violations yield a valid projection, detailed recovery, and retry paths without orphaned rolls or whole-game replacement.
- Room order is logical rather than wall-clock based. Opener loss, successor loss, expiry/rejoin, simultaneous admission, and partition healing converge deterministically without restoring expired priority from a save.
- Handover and a fresh room freeze the new priority participant's current validated version as the tenure-start fallback; delayed pre-tenure branches do not resurrect the previous priority participant's old value.
- Remembered available player selection is automatic; occupied/missing selections require a choice. Concurrent claims cannot produce dual confirmed occupancy within one synchronized reachable view; offline selections remain local/unconfirmed and are checked again on reconnection.
- Additional-player creation is rejected without reachable peers, with only signaling connected, before reconciliation, and after a disconnect during form submission. An admitted synchronized participant can create one valid player; name/role/size rules and replay deduplication still hold. Restoring a game offline cannot silently create another GM, while initial new-game bootstrap and loading existing saved players still work.
- Legacy snapshot imports, ambiguous no-history merges, version-2 causal roundtrips, inconsistent/tampered/oversized history, canceled replacement, denied/quota/corrupt storage, and recovery export preserve the last-good record.
- Long-running roll/history pruning and an old offline participant reconnecting do not resurrect duplicate events, erase compatible changes, or bypass size budgets.
- Network adapter tests cover malformed/oversized binary frames, backpressure, pending-work/peer limits, untrusted staging isolation, and complete timer/listener/channel/provider cleanup.
- Saves/downloads and redacted diagnostics contain no room secret, SDP/ICE, live occupancy, peer objects, or remembered browser identity.

### Actual browser flows

Run type checking, unit/DOM tests, and production build. Rewrite manual-exchange end-to-end flows to use the real public UI room-link workflow and actual browser data channels, not a fake provider or BroadcastChannel-only success.

Exercise a creator plus two other browsers using one link; initial and late state loading; simultaneous rolls; offline/local changes followed by reconciliation; automatic remembered selection and conflicting claims; first-participant departure with continued play and successor behavior; refreshed/rejoining participants; local/downloaded restoration; storage failure and pre-merge recovery; and signaling failure independent from an already-working channel.

Test each Playwright Chromium/Firefox/WebKit engine and cross-engine cases and report the exact observed matrix. Verify that signaling traffic never carries game state and no relay configuration is used. Deterministic unit-level coordinator/causal simulations supplement, but never replace, real-channel browser evidence.

The previous README records unproven combinations, and the Chrome/Safari debugging notes do not establish shipping Safari success. Preserve that distinction. Real Safari/Chrome, branded Edge/Firefox, and different-home-network smoke tests remain separate evidence. If public signaling or direct traversal fails, report exactly what failed without skipping the case or changing the privacy model to get green tests.

## Builder review resolutions

The independent builder review returned three material questions. One consolidated user-question round produced these resolutions:

1. **Priority handover/new room:** user approved resetting the starting fallback to the successor's current validated version or a fresh room opener's saved version. Tenure boundaries take precedence over a branch's older historical checkpoint; within a tenure retain the appropriate frozen causal fallback.
2. **Delayed descendants:** an edit based on only one competing branch, without observing its resolution, remains part of that conflict. Extending the resolution within the same tenure keeps the same fallback, independent of delivery order. This follows the agreed concurrent-versus-subsequent distinction, not a new earliest-author policy.
3. **Offline versus connected player creation:** user specified that new players can only be added once a connection is established, not offline. Implement the gate in both UI and operation admission; preserve existing-player offline work. Local offline selection is not a confirmed live claim, and the design explicitly limits occupancy guarantees to reconciled reachable membership rather than inferring impossible global exclusivity from this creation restriction. The initial new-game player bootstrap is the explicitly labeled designer call above.

After these revisions, the follow-up builder-readiness check returned “nothing important left.” This establishes planning readiness, not user approval, implemented functionality, or public-service/browser acceptance.

## Left to the builder

Exact filenames/interfaces, DOM composition, causal checkpoint encoding, bounded compaction summaries, IndexedDB transaction/index layout, disconnect/admission/transfer timeouts, frame/history/recovery budgets, deterministic partition tie-break encoding, test fixtures, and currently verified public endpoint configuration. Choose these within the stated behavior and gates; mark material design changes rather than silently relaxing requirements.

## Research references

- Current project: `README.md`, `AGENTS.md`, `src/game/`, `src/storage/`, `src/session/`, `src/ui/app.ts`, and `docs/superpowers/debugging/2026-10-31-chrome-safari-connection.md`.
- y-webrtc published package/source: <https://registry.npmjs.org/y-webrtc/latest> and <https://unpkg.com/y-webrtc@10.3.0/src/y-webrtc.js>.
- Upstream signaling behavior and documented options: <https://github.com/yjs/y-webrtc> and <https://unpkg.com/y-webrtc@10.3.0/bin/server.js>.
- Yjs update/causality primitives: <https://docs.yjs.dev/api/document-updates>.
- Local persistence background: <https://docs.yjs.dev/getting-started/allowing-offline-editing>.
