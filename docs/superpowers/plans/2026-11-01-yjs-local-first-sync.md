# Yjs Local-first Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual invitation/reply signaling and host-only state with reusable room links, Yjs reconciliation, local causal saves, and downloadable backups without uploading or relaying gameplay.

**Architecture:** Trystero Core with a bounded custom WSS signaling strategy synchronizes a transient Yjs staging document over direct WebRTC only; no BroadcastChannel path is used. Validated semantic operations cross into a separate durable Yjs workspace. A causal projector preserves independent changes and uses the first room participant's recorded value for genuine conflicts, with tenure resets on succession. Native IndexedDB persists an atomic snapshot/history pair; explicit session callbacks connect replaceable accessible views.

**Tech Stack:** Existing TypeScript/Vite, semantic HTML/CSS, Vitest/jsdom, Playwright, Node 22.12+ and npm; final runtime dependencies are exact `yjs@13.6.33` and `@trystero-p2p/core@0.26.0`, with test-only `fake-indexeddb@6.2.7`. Task 1 originally installed y-webrtc under the superseded provider choice; revised Task 2 removes y-webrtc and the temporary y-protocols dependency, adds Trystero Core, and keeps `package-lock.json` in sync.

**Spec:** `docs/superpowers/specs/2026-10-27-vtt-foundation-design.md` (existing boundaries), `docs/superpowers/specs/2026-11-01-yjs-local-first-sync-design.md` (approved product design), and `docs/superpowers/specs/2026-11-02-yjs-bounded-provider-design.md` (approved provider revision). The 2026-11-02 addendum supersedes only the provider-specific y-webrtc choice. Read all three and the current `AGENTS.md` before executing.

## Approved provider amendment — 2026-11-02

The user approved replacing stock y-webrtc with Trystero Core 0.26.0 and a custom `createTopicStrategy` adapter over the existing public WSS topic/pub-sub signaling service. Do not retain or restore the same-origin BroadcastChannel path. Task 1 and the first Task 2 attempt are historical commits; revised Task 2 removes `y-webrtc`/temporary `y-protocols`, adds `@trystero-p2p/core`, and replaces the provider lifecycle and gate tests. Tasks 3–11 remain paused until the revised Task 2 implementation passes review and its real-browser feasibility gate.

## Global Constraints

- Use Node.js **22.12+** and npm; update `package-lock.json` with dependencies. No framework or package-manager migration.
- Use Yjs CRDTs with Trystero Core 0.26.0 and the custom public-WSS strategy specified in `docs/superpowers/specs/2026-11-02-yjs-bounded-provider-design.md`. Public services do discovery/handshake only; no game-state server, cloud save, analytics, application backend, paid service, or TURN relay.
- “New players may only be added after a connection is established, not offline. This restriction does not prevent offline edits to existing players.” Preserve the approved initial new-game GM/player bootstrap exception.
- “For a genuine conflict, the first room participant's version wins, even when they authored neither competing change.” Resolve only affected fields/operations, retain unrelated changes, and show competing/retained values. No whole-game replacement or earliest-conflicting-author policy.
- A successor starts from their current validated version; a fresh room starts from its opener's saved version. Room membership, priority, credentials, and browser identity hints never belong in game backups.
- Keep **32 players**, **100 recent rolls**, and dice **d4/d6/d8/d10/d12/d20/d100**. Roles and remembered identities are not authentication. PJ sheets remain examples, not a feature to implement.
- Do not use BroadcastChannel as any room-data path. Native RTC browser acceptance cannot be replaced by a mock, BroadcastChannel-only result, skipped failure, relay, or privacy flag. Record exact engine/network limitations; WebKit is not shipping Safari, Chromium is not branded Edge.
- Preserve the working legacy app until the bounded-provider feasibility gate passes and the replacement is wired. New modules have separate names so early tasks can pass existing tests independently.
- The existing untracked `AGENTS.md` is user work. Preserve its content, make its instructions available if using a worktree, and do not stage the entire file incidentally. Do not reuse the old foundation plan's execution/main-branch choice as authorization for this plan.

## Review Focus

1. **Two tabs save the same game, or saves finish late:** stale writes must not silently overwrite a newer local history; Task 5 pins compare-and-swap storage versions and Task 10 pins UI generation checks.
2. **Leave/remount while crypto, RTC, import, or IndexedDB work is pending:** no late connection, stale view, revived room, or leaked resource; Tasks 2 and 10 pin this.
3. **Connection disappears after a new-player form is shown:** submitting must not append or queue an offline roster entry; Tasks 8 and 9 pin this below the UI as well as in the form.
4. **Operation-ID collision, missing/cyclic parents, or legacy snapshots with no shared history:** preserve accepted data, quarantine invalid operations, and distinguish ambiguity from proven concurrency; Tasks 3, 4, and 6 pin this.
5. **Old offline history returns after roll trimming or history fills:** no duplicate/resurrected events, lost independent edits, or destructive snapshot reseeding; Tasks 3, 4, and 8 pin safe retention/limit behavior.

---

## Execution order and concrete planning choices

One cohesive plan is appropriate: the network, causal model, persistence, and UI implement one joining/reconciliation contract, not independent products. Execute Tasks 1–11 in order. **Pause after Task 2 if actual public signaling/RTC or documented adapter hooks cannot meet the gate.** Do not spend later tasks assuming an unproven transport works or retire the legacy flow to hide the failure.

The following are implementation-budget choices, not newly attributed user requirements. Put the constants in `src/network/limits.ts` and reuse them rather than scattering literals:

| Limit | Value |
|---|---:|
| Frame bytes / binary header bytes | 16,384 / 16 |
| Reassembled sync message / maximum chunks | 2 MiB / 256 |
| Incomplete transfers per connection / timeout | 4 / 10,000 ms |
| Total pending inbound bytes across local connections | 8 MiB |
| Queued outbound bytes per connection / total | 4 MiB / 8 MiB |
| Native channel buffered bytes / low threshold | 1 MiB / 65,536 |
| Native remote connections / admitted participants / pending admissions | 31 / 32 / 8 |
| Durable encoded workspace / game operations / causal parents per operation | 1 MiB / 4,096 / 128 |
| Pending missing-dependency operations | 128 |
| Transient control entries / encoded control bytes / awareness state bytes | 256 / 128 KiB / 8 KiB |
| JSON backup / legacy version-1 JSON import | 4 MiB / 1 MiB |
| Recovery snapshots | 1 pre-reconciliation copy per game |
| Presence heartbeat / expiry / public-service probe timeout | 5,000 / 30,000 / 8,000 ms |
| Per-participant action tokens | burst 20, refill 10/second; do not charge binary fragments as actions |

These increase the old JSON transport's 256-KiB message bound deliberately to accommodate causal binary history while retaining small frames and explicit aggregate budgets. At a durable-history bound, reject further growing mutations with a download/recovery explanation; do not silently compact away causality. Keep all history up to that bound for this migration; no speculative destructive compactor is required. Materialized roll trimming is separate from causal evidence retention.

Use the existing two Google STUN URLs from `src/network/config.ts`, explicitly passed in Trystero's `rtcConfig.iceServers`, with no TURN. Start public-service verification with `wss://y-webrtc-eu.fly.dev`, whose generic topic/pub-sub protocol is implemented by the current public endpoint but whose reachability is intermittent. Probe both WSS and subscribe/publish compatibility. A different free compatible endpoint may replace it only after checking operator/privacy compatibility and actual reachability, and documenting that choice. Zero verified endpoints is a blocker, not permission to self-host or mock acceptance. Build-time `VITE_GATHER_SIGNALING_URLS` may override the list with validated `wss:` URLs; never accept an endpoint from an incoming room link.

## File responsibility map

| Area | New/changed files and responsibilities |
|---|---|
| Network | `room-link.ts` codec; `limits.ts` budgets; `config.ts` explicit WSS/STUN; `trystero-signaling.ts` custom `createTopicStrategy`; `binary-framing.ts` byte framing; `rtc-runtime.ts` guarded Trystero `rtcPolyfill`; `room.ts` bounded Trystero Core lifecycle and truthful progress |
| Domain | `sync-types.ts` causal contracts; `history.ts` validation, DAG/frontiers and projection; `workspace.ts` durable Y.Doc adapter; `reconcile.ts` granular priority/legacy/invariant resolution |
| Storage | `workspace-repository.ts` atomic IndexedDB/CAS/recovery and legacy migration; `backups.ts` validated version-2/legacy file boundary. Existing `repository.ts` remains the small legacy-reader/identity-hint adapter |
| Session | `membership.ts` transient logical order/tenures; `peer-types.ts` new view/controller contracts; `workspace-bridge.ts` staging admission; `peer.ts` local/room orchestration, claims and online creation |
| Views | `share.ts`, `player.ts`, `table.ts`, `restore-game.ts` independently tested new views; existing `start.ts` text and `app.ts` async wiring change only at cutover |
| Verification | Matching tests under `tests/`; new helpers `workspace.ts`, `rooms.ts`; provider-gate browser fixture; `scripts/check-signaling.mjs`; existing e2e flows rewritten, not skipped |

Paths in the table are relative to their existing `src/network/`, `src/game/`, `src/storage/`, `src/session/`, or `src/ui/` area. Tests in each task below have full paths. `src/game/types.ts`, validation, random dice, and pure legacy model operations remain reusable; `src/main.ts` remains bootstrap.

### Task 1: Versioned room links and explicit network configuration

**Files:** Create `src/network/room-link.ts`, `src/network/limits.ts`, `tests/network/room-link.test.ts`, `tests/network/config.test.ts`; modify `src/network/config.ts`, `package.json`, `package-lock.json`.

**Interfaces:** Produce `RoomLink = {version:2;roomId:string;gameId:string;secret:string}`, `createRoomLink(gameId:string):RoomLink`, `roomLink(value:RoomLink,baseUrl:string):string`, and `decodeRoomLink(input:string):RoomLink`. Export `roomNetworkConfig:{signaling:string[];rtc:RTCConfiguration}` alongside existing `rtcConfiguration`; keep legacy exports working. Export the named constants corresponding to the budget table.

- [ ] **Step 1: Write failing codec/config tests.** Generate secret material only at test runtime; never commit live links or credentials as fixtures.
  ```ts
  it('roundtrips fragment-only room/game IDs without SDP or a game payload', () => {
    const descriptor = createRoomLink('game');
    const url = new URL(roomLink(descriptor, 'https://example.test/table?theme=light'));
    expect(decodeRoomLink(url.href)).toEqual(descriptor);
    expect(url.search).toBe('?theme=light');
    expect(url.hash.startsWith('#room=')).toBe(true);
    expect(descriptor.secret).toHaveLength(43);
    expect(Object.keys(descriptor).sort()).toEqual(['gameId','roomId','secret','version']);
  });
  ```
  Add named cases `rejects invalid version/extra keys/secret/oversized input/legacy reply`, each asserting `toThrow()`, and `uses explicit STUN-only ICE`, asserting every ICE URL starts with `stun:` and signaling uses `wss:`.
- [ ] **Step 2: Run red.** `npm test -- tests/network/room-link.test.ts tests/network/config.test.ts` must fail on missing exports/modules.
- [ ] **Step 3: Add the domain runtime dependency and implement the signatures.** Keep exact `yjs@13.6.33`; provider dependencies are added/replaced by Task 2. Encode bounded UTF-8 JSON as base64url in `#room=`; generate a UUID room ID and 32 random secret bytes. Reject inputs over 8,192 bytes and encoded descriptors over 2,048 bytes. Validate exact keys/version, existing game-ID rules, UUID room ID, and a 32-byte decoded secret. Preserve app origin/path/query and do not start a provider. Validate configured endpoint URLs with a maximum of 4 entries.
- [ ] **Step 4: Verify green.** Run the focused tests, `npm run typecheck`, and `npm run build`; all must exit 0 and the legacy app must still build.
- [ ] **Step 5: Commit only these files.** `git commit -m "feat: add versioned private room links and explicit peer configuration"` after staging only the Files list for this task.

### Task 2: Bounded Trystero Core transport and public-WSS feasibility gate

**Files:** Create `src/network/trystero-signaling.ts`, `tests/network/trystero-signaling.test.ts`; revise `src/network/binary-framing.ts`, `src/network/rtc-runtime.ts`, `src/network/room.ts`, `scripts/check-signaling.mjs`, `tests/network/binary-framing.test.ts`, `tests/network/rtc-runtime.test.ts`, `tests/network/room.test.ts`, `tests/e2e/provider-gate.spec.ts`, `tests/e2e/fixtures/provider-gate.html`, `tests/e2e/fixtures/provider-gate.ts`, and `docs/superpowers/debugging/2026-11-01-yjs-provider-gate.md`; modify `package.json`, `package-lock.json`, `playwright.config.ts`.

**Interfaces:** Consume Task 1. Produce `createGatherSignalingStrategy():JoinRoom<JoinRoomConfig>` with public Trystero `createTopicStrategy`; the adapter uses `relayConfig.urls` and generic WSS `subscribe`/`unsubscribe`/`publish` messages. Produce `encodeBinaryFrames(data:Uint8Array,transferId:number):Iterable<Uint8Array>` and `createBinaryAssembler(now:()=>number,budget:InboundBudget,onExpire:(transferId:number)=>void)` with `accept(frame:Uint8Array):Uint8Array|undefined`, `clear():void`; `InboundBudget` tracks aggregate reserved bytes across native connections. Define `RtcConstructors=Pick<typeof globalThis,'RTCPeerConnection'>`; produce `createBoundedRtcRuntime(options:{native?:RtcConstructors;now:()=>number;onChange:()=>void;onError:(message:string)=>void})` returning `{rtcPolyfill:RtcConstructors['RTCPeerConnection'];getOpenCount():number;close():void}`. Produce `createRoomTransport(doc:Y.Doc,link:RoomLink,participantId:string):RoomTransport`; its view contains phase (`looking|connected|failed|closed`), actual `openRtcConnections:number`, local-time `presence:Array<{id:string;seenAt:number}>`, and redacted `error:string|null`.

- [ ] **Step 1: Write failing framing, signaling-strategy, lifecycle, and actual-provider tests.** First extend the interoperability project's testMatch to include `provider-gate.spec.ts` as well as `connections.spec.ts`, and exclude both from per-engine default discovery. Add a strategy test proving the adapter sends only WSS topic `subscribe`/`publish` envelopes and routes matching published `data`; it rejects malformed, wrong-topic, and over-128-KiB encoded control messages. The browser test uses two isolated contexts and actual Trystero Core actions over the custom WSS strategy.
  ```ts
  it('frames and exactly reassembles a 2-MiB binary sync message', () => {
    const bytes = new Uint8Array(2 * 1024 * 1024).fill(7);
    const assembler = createBinaryAssembler(() => 0, createInboundBudget(), vi.fn());
    let result: Uint8Array | undefined;
    for (const frame of encodeBinaryFrames(bytes, 1)) {
      expect(frame.byteLength).toBeLessThanOrEqual(16_384);
      result = assembler.accept(frame);
    }
    expect(result).toEqual(bytes);
  });
  ```
-  Define `createInboundBudget():InboundBudget` in the framing module. Add cases with `toThrow()` for bad header/count/index, duplicates, 2-MiB+1 payload, fifth incomplete transfer, 8-MiB aggregate overflow, and expiry at 10,001 ms; assert expiry releases its reservation and fails the attributable peer. Runtime tests assert exact physical frame and buffer caps, one bounded channel per peer, peer isolation on invalid frames, surfaced send failures, and zero native objects/timers during close/start races (Review Focus 2). Set Trystero `maxReceiveBytes` to 8 MiB and test `onReceive` rejection of a single payload over 2 MiB and excess pending transfers. The provider fixture has connect/publish/large publish/close controls and visible actual native-open count/received value; no debug global.
- [ ] **Step 2: Run red.** Run the four new network test files and `npm run test:e2e -- --project=interoperability tests/e2e/provider-gate.spec.ts`; failures must be missing functionality, not a substituted provider.
- [ ] **Step 3: Implement framing and the native guard.** Use the 16-byte big-endian header: magic `0x47544832`, version byte 2, flags byte 0, uint32 transfer ID, uint16 index/count/payload length. Lazily frame messages so queued/native buffering budgets are enforced without eagerly copying every fragment. Wrap Trystero Core's native `RTCPeerConnection` via the documented `rtcPolyfill` constructor; bind native methods and forward reconstructed binary `MessageEvent`s. Require one ordered/reliable channel per peer and retain the exact 16-KiB physical-frame cap after accounting for Trystero room/action envelopes. Bound transfers, send queues, connection count, and cleanup; catch decoder/listener failure at dispatch and report only safe state labels. Do not use private Trystero internals, BroadcastChannel, vendored patches, or global RTC replacement.
- [ ] **Step 4: Implement the public WSS strategy and Trystero room lifecycle.** Implement `createGatherSignalingStrategy()` with public Core `createTopicStrategy`: connect to `relayConfig.urls`, send generic WSS `subscribe`/`unsubscribe`/`publish` JSON, map matching `{topic,data}` messages to the topic callback, and clean up sockets/subscriptions on leave. Do not use the Trystero umbrella package/default Nostr strategy. Lazily join only after explicit user consent and feature checks by calling the returned joiner with `link.roomId` and config `{appId:'gather-v2',password:link.secret,maxReceiveBytes:8*MiB,relayConfig:{urls:roomNetworkConfig.signaling},rtcConfig:roomNetworkConfig.rtc,rtcPolyfill}`. The handshake exchanges the protocol version and opaque participant ID; it does not authenticate a person. Use action IDs `gather-sync-v2` and `gather-presence-v2`. On `room.onPeerJoin(peerId)`, send `Y.encodeStateAsUpdate(doc)` only to that peer; broadcast incremental Yjs update bytes to connected peers excluding the sending origin. On receive, call `Y.applyUpdate(doc,bytes,peerId)` so remote updates are never echoed to their source. Presence carries the opaque `participantId` and heartbeat; validate UTF-8 payloads at 8 KiB, cap transient control entries at 256, heartbeat every 5,000 ms, timestamp locally, and expire after 30,000 ms. Derive `phase` from actual native data-channel opens only. Configure action admission to reject a single payload over 2 MiB, more than 4 pending transfers per peer, and aggregate pending data over 8 MiB; track inactivity and close the attributable peer at the deadline. `close()` marks closed first, leaves Trystero, unsubscribes relays, closes the runtime, and never destroys the caller's Y.Doc. No BroadcastChannel is used.
- [ ] **Step 5: Verify signaling compatibility and the technical gate.** Run unit tests, typecheck/build, and `npm run check:signaling -- wss://y-webrtc-eu.fly.dev`; the probe must validate WSS and complete a random temporary topic subscribe/publish roundtrip within 8 seconds, with no credentials, SDP/ICE, or game state. Then run actual Chromium↔WebKit provider-gate cases in `interoperability`. Assert `openRtcConnections>0` on both peers, byte-for-byte large-value delivery, teardown, and continued direct-channel operation after closing only the actual signaling sockets. Use the test discovery configured in Step 1. If the Node probe fails but real browser proof succeeds, record the difference rather than treating it as a veto. If endpoint compatibility, documented Core hooks, or any all-path bound fails, append exact revised-provider evidence to `docs/superpowers/debugging/2026-11-01-yjs-provider-gate.md` while preserving the previous y-webrtc result as history and pause: **the gate is not green and Task 3 must not assume it is.** A passing pair does not prove the final matrix.
- [ ] **Step 7: Commit gate deliverable/evidence.** Commit only the listed adapter/tests/config/script paths and the evidence note with message `feat: add bounded Trystero Core transport and WSS feasibility gate`; accurately label any blocker, never a false pass.

### Task 3: Durable causal history and local Yjs workspaces

**Files:** Create `src/game/sync-types.ts`, `src/game/history.ts`, `src/game/workspace.ts`, `tests/game/history.test.ts`, `tests/game/workspace.test.ts`, `tests/helpers/workspace.ts`.

**Interfaces:** Define `WorkspaceSnapshot={game:Game;history:Uint8Array}`, `GameHistory={modelVersion:1;gameId:string;seeds:Record<string,Game>;operations:Record<string,GameOperation>}`, and `LocalEdit` variants `set-game-name` (`name`), `set-player-name` (`playerId,name`), `set-player-role` (`playerId,role`), `roll` (`playerId,sides`). `GameOperation` is a validated immutable union of field write, connected roster addition, roll, and causal resolution; each has `id`, `authorId:string`, `parents:string[]`, `at` and its variant payload. Seed IDs are valid causal parents; seeds plus operations share the 4,096-entry budget. authorId is opaque change provenance, not a saved active identity, admission rank, or authorization. Resolution payload retains affected fields/patches, candidate heads, fallback base/frontier, and any extended resolution IDs, but no live room membership/credentials. Define `ConflictNotice`, `PriorityContext={participantId:string;tenureId:string;baseline:GameHistory}`, and `Reconciliation={history:GameHistory;game:Game;notices:ConflictNotice[];pendingIds:string[];rejectedIds:string[]}` here for later tasks. The returned history includes validated resolved candidates, not missing-parent/cyclic operations; pending/rejected IDs describe work retained outside accepted history.

Produce `createWorkspace(input:Game|WorkspaceSnapshot,runtime:Runtime,replicaId?:string):Workspace`, `validateWorkspaceSnapshot(snapshot:WorkspaceSnapshot):WorkspaceSnapshot`, `mergeHistory(base:GameHistory,incoming:GameHistory):GameHistory`, `projectHistory(history:GameHistory):Game`, and `makeRosterAddition(history:GameHistory,player:Player,runtime:Runtime,authorId:string):GameOperation` (pure construction; live permission belongs to Task 8). `Workspace` exposes readonly `replicaId:string`, `getHistory():GameHistory`, `getSnapshot():WorkspaceSnapshot`, `applyLocal(edit:LocalEdit):void`, `accept(history:GameHistory):void`, `subscribe(fn:()=>void):()=>void`, `destroy():void`. A fresh replica ID is generated per opening unless explicitly supplied; it is not restored from the file or stored as active browser identity. Each getter returns detached data. Helpers export `namedRuntime(label:string):Runtime`, `createTestWorkspace(label:string,game?:Game):Workspace`, `forkTestWorkspace(source:Workspace,label:string):Workspace`, and `fixtureRoster():Game` (existing Alex/Bea/Cy records, not offline additions).

- [ ] **Step 1: Write failing local/history tests.**
  ```ts
  it('preserves lineage across fork/save/reload instead of reseeding JSON', () => {
    const a = createTestWorkspace('a');
    const b = forkTestWorkspace(a, 'b');
    b.applyLocal({type:'roll',playerId:'alex',sides:20});
    const restored = createWorkspace(b.getSnapshot(), namedRuntime('restored'));
    expect(restored.getHistory()).toEqual(b.getHistory());
    expect(restored.getSnapshot().game.rolls).toHaveLength(1);
  });
  ```
  Add exact assertions: operation-ID reuse with different content and cyclic parents throw without changing the prior snapshot; missing parents are distinguishable from cycles for staging; unsupported fields/invalid roles/dice/reference/game IDs fail. At 600 rolls the projection has 100 unique rolls, replaying an old fork does not restore trimmed results, and at 4,096 operations or 1-MiB history the next growing mutation throws while the previous snapshot stays downloadable (Review Focus 4/5).
- [ ] **Step 2: Run red.** `npm test -- tests/game/history.test.ts tests/game/workspace.test.ts` must fail on missing modules.
- [ ] **Step 3: Implement the contracts.** Keep semantic IDs/parents independent of internal Yjs struct IDs. Use separate Y.Map entries for seeds and operations; never assign an entire live Game/sheet JSON value. `applyLocal` records authorId=workspace.replicaId, validates/captures the current causal frontier, and uses the injected unbiased die runtime for rolls. It cannot create roster entries. Project the latest 100 rolls in stable causal-depth/operation-ID order, never wall-clock authority; retain their causal evidence up to the safe history bound. Derive snapshot revision from the maximum seed revision plus distinct admitted non-resolution operations; compute updatedAt from valid retained seed/operation timestamps, not freshness authority. Reject unresolved invalid projections in `accept`/snapshot validation rather than persisting staging.
- [ ] **Step 4: Verify green.** Run focused tests plus existing `tests/game/`, typecheck/build; legacy app still compiles and tests pass.
- [ ] **Step 5: Commit.** Stage only this task's files and commit `feat: add validated causal Yjs workspaces and local operations`.

### Task 4: Granular priority reconciliation and causal resolutions

**Files:** Create `src/game/reconcile.ts`, `tests/game/reconcile.test.ts`; extend `tests/game/history.test.ts`, `tests/helpers/workspace.ts` only as needed for shared assertions.

**Interfaces:** Consume Task 3. Produce `capturePriority(history:GameHistory,participantId:string,tenureId:string):PriorityContext` and `reconcileHistories(histories:readonly GameHistory[],priority:PriorityContext,runtime:Runtime):Reconciliation`. `ConflictNotice` must expose stable notice ID, affected fields/records, reason (`concurrent-value|invariant|limited-history`), candidate values/operation IDs, retained value, and an explanation suitable for text rendering. No transient peer data goes in durable resolution operations.

- [ ] **Step 1: Write failing conflict tests, including delivery permutations.**
  ```ts
  it.each([false,true])('keeps Alice’s untouched value, not an earlier conflicting author (%s)', reverse => {
    const alice = createTestWorkspace('alice', {...fixtureRoster(),name:'Old Castle'});
    const bob = forkTestWorkspace(alice,'bob'), carol = forkTestWorkspace(alice,'carol');
    const priority = capturePriority(alice.getHistory(),alice.replicaId,'tenure-1');
    bob.applyLocal({type:'set-game-name',name:'Red Castle'});
    carol.applyLocal({type:'set-game-name',name:'Blue Castle'});
    const branches = [bob.getHistory(),carol.getHistory()];
    const result = reconcileHistories([alice.getHistory(),...(reverse?branches.reverse():branches)],priority,namedRuntime('resolve'));
    expect(result.game.name).toBe('Old Castle');
    expect(result.notices).toHaveLength(1);
  });
  ```
  Pin these named assertions: `independent records/fields` → both edits retained, `notices=[]`; `single offline edit vs unchanged` → edited value; `equal concurrent values` → no warning; `observed resolution then new edit` → new value; `late Green descendant never saw Red/Blue resolution` → Old in all-at-once and split delivery; `Alice also edits` → her value; `Dave successor/fresh room starts at accepted Red` → Red, not historical Old. Duplicate names/new records plus dependent rolls must produce a valid roster, recoverable affected proposals, and retain an unrelated roll. Diverged legacy seeds use `limited-history`, union compatible additions, and never infer deletion from absence. Replayed resolutions do not duplicate notices or operations.
- [ ] **Step 2: Run red.** `npm test -- tests/game/reconcile.test.ts` must fail on the missing reconciler/expected behavior.
- [ ] **Step 3: Implement field/operation-component reconciliation.** Walk the bounded DAG and compare causal heads, not timestamps. Use the priority participant's contribution at the conflict's base, clamped to the current tenure's baseline; identify its own later relevant edits by authorId matching priority.participantId, not by whatever remote value happened to arrive in its projection first. Retain the original group/base on a resolution so a delayed branch descendant extends the group instead of treating delivery-after-resolution as causality. Only a write observing the relevant resolution supersedes it normally. Expand invariant components only to dependent operations, retaining first-participant values/absence and quarantining invalid operations. Record missing dependencies in the bounded pending set. Persist resolutions accounting for all competing heads; never silently apply Y.Map's key winner or replace the game.
- [ ] **Step 4: Verify green.** Run all `tests/game/`, typecheck/build; run the permutation tests twice with different runtime label/ID sequences and require identical materialized values/notice identity for the same conflict inputs.
- [ ] **Step 5: Commit.** Commit the listed paths as `feat: reconcile granular conflicts with first-participant checkpoints`.

### Task 5: Atomic IndexedDB workspace saves, recovery, and legacy migration

**Files:** Create `src/storage/workspace-repository.ts`, `tests/storage/workspace-repository.test.ts`; modify `package.json`, `package-lock.json`. Reuse `src/storage/repository.ts` strictly for validated legacy reads and separate identity hints; do not break its old callers yet.

**Interfaces:** Produce `createWorkspaceRepository(options:{indexedDB?:IDBFactory;storage?:Storage;runtime:Runtime;dbName?:string}):WorkspaceRepository` and `browserWorkspaceRepository(runtime:Runtime):WorkspaceRepository`. Methods: `list():Promise<{games:Game[];warnings:string[]}>`; `load(id:string):Promise<{snapshot:WorkspaceSnapshot|null;version:number;warnings:string[]}>`; `save(snapshot:WorkspaceSnapshot,expectedVersion:number):Promise<WorkspaceSaveResult>`; `saveRecovery(snapshot:WorkspaceSnapshot):Promise<SaveResult>`; `loadRecovery(id:string):Promise<WorkspaceSnapshot|null>`; synchronous `rememberedPlayer(id:string):string|null`, `rememberPlayer(gameId:string,playerId:string):SaveResult`; `close():void`. `WorkspaceSaveResult` is `{ok:true;version:number}|{ok:false;reason:'storage'|'stale';message:string}`. Version 0 means no durable record. `SaveResult` retains the existing `{ok:true}|{ok:false;message:string}` shape for identity/recovery.

- [ ] **Step 1: Write failing transactional tests with fake IndexedDB.**
  ```ts
  it('rejects a stale second-tab save without overwriting newer history', async () => {
    const indexedDB = new IDBFactory(), dbName = crypto.randomUUID();
    const one = createWorkspaceRepository({indexedDB,dbName,runtime:namedRuntime('one')});
    const two = createWorkspaceRepository({indexedDB,dbName,runtime:namedRuntime('two')});
    const initial = createTestWorkspace('seed').getSnapshot();
    expect(await one.save(initial,0)).toEqual({ok:true,version:1});
    const a = await one.load(initial.game.id), b = await two.load(initial.game.id);
    expect(await one.save(a.snapshot!,a.version)).toEqual({ok:true,version:2});
    expect(await two.save(b.snapshot!,b.version)).toMatchObject({ok:false,reason:'stale'});
    expect((await two.load(initial.game.id)).version).toBe(2);
  });
  ```
  Also assert aborted writes retain the prior snapshot AND history, corrupt records do not hide other games, one recovery slot replaces only that game's prior recovery, legacy records remain untouched until migration transaction completion, and denied/blocked/versionchanged database handles settle with warnings rather than hanging. A missing/throwing localStorage affects hints independently from working IndexedDB (Review Focus 1/2).
- [ ] **Step 2: Add test-only dependency and run red.** `npm install --save-dev --save-exact fake-indexeddb@6.2.7`; run `npm test -- tests/storage/workspace-repository.test.ts` and expect missing repository functionality.
- [ ] **Step 3: Implement the repository.** Use database `gather-workspaces`, version 1, stores `games` and `recovery` keyed by game ID. Each game record atomically holds `{id,version,snapshot}`; verify `validateWorkspaceSnapshot` before writes/after reads. In one readwrite transaction compare expectedVersion and write version+1, never use legacy game.revision as CAS. Scan valid legacy `gather:game:` records on list/load; seed/migrate lazily on load, preserve legacy bytes, and return a usable in-memory snapshot/warning if migration cannot persist. Close on versionchange; settle an open blocked beyond 1,000 ms as unavailable. Do not store a room link or local identity in the game record.
- [ ] **Step 4: Verify green.** Run `npm test -- tests/storage/`, typecheck/build; all old app tests remain valid because cutover has not happened.
- [ ] **Step 5: Commit.** Commit repository/tests/dependency files as `feat: persist causal workspaces atomically with safe legacy migration`.

### Task 6: History-preserving portable backups and isolated import validation

**Files:** Create `src/storage/backups.ts`, `tests/storage/backups.test.ts`; leave old `src/storage/files.ts` working until Task 10.

**Interfaces:** Produce `serializeBackup(snapshot:WorkspaceSnapshot):string`, `parseBackup(text:string,runtime:Runtime):WorkspaceSnapshot`, `parseBackupFile(file:File,runtime:Runtime):Promise<WorkspaceSnapshot>`, `downloadBackup(snapshot:WorkspaceSnapshot):void`. Exact outer schema: `{format:'gather-game',formatVersion:2,game:Game,history:{modelVersion:1,encoding:'base64',update:string}}`; no additional keys. Legacy bare schemaVersion-1 Game is accepted under the 1-MiB legacy limit and seeded once.

- [ ] **Step 1: Write failing roundtrip/tamper tests.**
  ```ts
  it('rejects an embedded snapshot inconsistent with the causal update', () => {
    const original = createTestWorkspace('saved').getSnapshot();
    const json = JSON.parse(serializeBackup(original));
    json.game.name = 'Different projection';
    expect(() => parseBackup(JSON.stringify(json),namedRuntime('import'))).toThrow();
    expect(parseBackup(serializeBackup(original),namedRuntime('good')).game).toEqual(original.game);
  });
  ```
  Assert legacy import works, unsupported/extra fields fail, decoded history over 1 MiB and JSON over 4 MiB fail before application, a cycle/missing causal root/operation collision fails in an isolated doc, and serialize/parse retain valid losing-candidate history/recovery without room credentials/occupancy/identity hints. `downloadBackup` must revoke its temporary URL even after a click error.
- [ ] **Step 2: Run red.** `npm test -- tests/storage/backups.test.ts` must fail on missing exports.
- [ ] **Step 3: Implement the file boundary.** Check actual UTF-8 byte lengths as well as File.size and encoded/decoded bounds; validate strict keys/versions/base64. Decode into an isolated Y.Doc, validate graph/projected snapshot equality, and destroy it on every path. No repository write happens here. Use `gather-<game-id>.json` and `application/json`, keeping credentials/session fields out of both snapshot and history.
- [ ] **Step 4: Verify green.** Run `npm test -- tests/storage/`, typecheck/build. Extend Task 4's backup-restored branch test to prove semantic IDs/causality survive, while a fresh room's tenure is not restored from the file.
- [ ] **Step 5: Commit.** Commit the new backup module/tests as `feat: export causal JSON backups and validate imports in isolation`.

### Task 7: Transient logical membership, priority succession, and tenure boundaries

**Files:** Create `src/session/membership.ts`, `src/session/peer-types.ts`, `tests/session/membership.test.ts`.

**Interfaces:** Define `Member={id:string;order:number}`, `Tenure={id:string;term:number;leaderId:string}`, validated `MembershipEvent` variants for admission request/grant, leave/expiry, and tenure transition, and `MembershipView={members:Member[];tenure:Tenure|null;ambiguous:boolean}` in `membership.ts`. Produce `createMembership(options:{localId:string;founder:boolean;now:()=>number;id:()=>string;publish:(event:MembershipEvent)=>void})` with `observe(events:readonly MembershipEvent[],presence:readonly {id:string;seenAt:number}[]):void`, `tick():void`, `getView():MembershipView`, `subscribe(fn:()=>void):()=>void`, `leave():void`, `destroy():void`. `peer-types.ts` may initially reexport these types; finish `PeerSessionView`/controller there in Task 8, not by modifying the legacy host/guest types.

- [ ] **Step 1: Write failing membership tests.** With admitted Alice/Bob/Carol test events and a fake local clock, assert `expect(view.members.map(m=>m.id)).toEqual(['alice','bob','carol'])` despite skewed remote timestamps. In `expires founder and elects next admitted member`, advance to 30,001 ms and assert `expect(view.tenure!.leaderId).toBe('bob')`. In `rejoin loses prior rank`, assert `expect(view.members.map(m=>m.id)).toEqual(['bob','carol','alice-new'])`. Equal-term split candidates delivered in both orders must satisfy `expect(left.getView()).toEqual(right.getView())` and `expect(left.getView().ambiguous).toBe(true)`. Reloaded game snapshots must supply no membership.
- [ ] **Step 2: Run red.** `npm test -- tests/session/membership.test.ts` must fail on missing exports.
- [ ] **Step 3: Implement bounded transient order and succession.** Assign founder order 0 and later orders via the active leader's logical max+1 grants. Expiry uses locally observed presence and the 30-second grace, not remote timestamps. Successors are the least ordered reachable admitted members. A tenure transition increments term; converge competing same-term candidates by previous admitted order then participant ID, flag ambiguity, and re-admit expired/losing-branch identities rather than restoring old priority. Reject stale-term control requests; cap and checkpoint the transient control view without moving it into durable game history. Emit one transition so Task 8 freezes a new `capturePriority` baseline.
- [ ] **Step 4: Verify green.** Focused tests plus `npm test -- tests/session/`, typecheck/build. Simulate asymmetric delivery, successor loss, explicit leave, transient recovery within grace, partition healing, and flood/unknown grantors; assert convergence and no game-state mutation.
- [ ] **Step 5: Commit.** Commit these files as `feat: track logical room membership and priority succession`.

### Task 8: Staging-to-workspace peer sessions and connected-only roster admission

**Files:** Create `src/session/workspace-bridge.ts`, `src/session/peer.ts`, `tests/session/workspace-bridge.test.ts`, `tests/session/peer.test.ts`, `tests/helpers/rooms.ts`; finish `src/session/peer-types.ts`. Keep legacy session files intact until cutover.

**Interfaces:** `createWorkspaceBridge(stage:Y.Doc,workspace:Workspace)` exposes `readCandidates():GameHistory[]`, `publish(history:GameHistory):void`, `admit(history:GameHistory):void`, `destroy():void`; validate immutable IDs/allowed roots/size before accepted workspace admission. `createPeerSession(options:{initial:WorkspaceSnapshot|null;rememberedPlayerId:string|null;runtime:Runtime;now:()=>number;createTransport?:typeof createRoomTransport}):PeerSession`. Controller: `getView():PeerSessionView`, `getSnapshot():WorkspaceSnapshot|null`, `getRecoverySnapshot():WorkspaceSnapshot|null`, `getRoomLink():RoomLink|null`, `subscribe(fn:()=>void):()=>void`, `openRoom():RoomLink|null`, `joinRoom(link:RoomLink):void`, `selectPlayer(id:string):void`, `createPlayer(name:string,role:Role):void`, `roll(sides:DieSides):void`, `edit(edit:LocalEdit):void`, `disconnect():void`, `close():void`.

`PeerSessionView` contains `game:Game|null`, phase (`local|waiting|syncing|choosing|ready|offline|closed`), localPlayerId, onlinePlayerIds, priorityParticipantId, canCreatePlayer, canRoll, hasRecovery, conflicts, error, and saveGeneration. saveGeneration changes only for accepted workspace changes and is scoped to this controller, not a global revision. Helpers export `createSessionHarness()` with `add(label:string,initial:WorkspaceSnapshot|null,rememberedId?:string|null):PeerSession`, `connect(...labels:string[]):void`, `disconnect(label:string):void`, `advance(ms:number):void`, `flush():Promise<void>`, `destroy():void`; this is deterministic Y.Doc/presence delivery for unit tests only, not mocked browser acceptance.

- [ ] **Step 1: Write failing session/bridge tests.**
  ```ts
  it('rejects creation after losing the connection without queuing an addition', async () => {
    const h = createSessionHarness();
    const a = h.add('a',createTestWorkspace('seed').getSnapshot(),'alex');
    const b = h.add('b',null);
    h.connect('a','b'); await h.flush();
    expect(b.getView().canCreatePlayer).toBe(true);
    h.disconnect('b');
    b.createPlayer('Bea','pj');
    expect(b.getView().game!.players).toHaveLength(1);
    h.connect('a','b'); await h.flush();
    expect(a.getView().game!.players).toHaveLength(1);
    h.destroy();
  });
  ```
  Pin signaling-only and not-yet-reconciled creation to `canCreatePlayer===false`; connected creation then duplicate request yields exactly one player. Offline existing-player rolls succeed. Missing/occupied remembered IDs do not silently select someone else; valid available IDs auto-select. Two concurrent claims yield one confirmed owner per reconciled view. Priority loss captures successor current history, not expired fallback. Malicious staging/ID rewrite/dependency overflow cannot change the prior durable snapshot; valid independent operations in the same batch survive. Before admitting a merge, `getRecoverySnapshot()` equals the pre-merge copy. Long-history admission failure leaves downloads/local state intact (Review Focus 3–5).
- [ ] **Step 2: Run red.** Run both new session test files and expect missing controller/bridge behavior.
- [ ] **Step 3: Implement orchestration and admission.** Own the transient stage/control doc and durable workspace separately; mirror validated semantic IDs/parents without converting the whole game to JSON. Generate one local participant ID at controller creation and pass it as workspace.replicaId, including when a workspace is first loaded from peers, so local author IDs and priority.participantId align. Subscribe to actual transport/presence and logical membership. Freeze pre-merge/tenure baselines before admitting candidates, have only the active priority participant publish current-tenure resolutions, and validate incoming resolutions against that view. Preserve compatible offline operations; capture recovery in memory before acceptance. New-player and live-claim intents are transient, bounded, deduplicated and checked for active synchronized reachability by the priority participant; only then use `makeRosterAddition` with that producer's authorId. Do not replay an expired/offline creation intent later. Accepted historical additions remain replayable. Public action methods report validation failures in view.error without throwing through DOM callbacks or mutating the prior accepted snapshot.
- [ ] **Step 4: Complete state/cleanup behavior.** Detect staging/control encoded-limit failures, preserve accepted workspace, and close the offending channel where attributable or the room if attribution is unavailable. Rate-limit actions, not sync fragments. Disconnected existing-player selections become local/unconfirmed; `canRoll` remains true for supported local play, `canCreatePlayer` false without a reachable synchronized peer/priority. Same-game incoming links attach existing local edits; wrong game IDs fail safely. `disconnect` keeps workspace; `close` destroys owned documents, subscriptions, timers and transport idempotently.
- [ ] **Step 5: Verify green.** Run all domain/storage/session/network unit tests and typecheck/build. Assert identical accepted game/history across the harness after reorder, loss, rejoin and a late third participant; no room descriptors/control/identity hints in getSnapshot.
- [ ] **Step 6: Commit.** Commit task paths as `feat: orchestrate causal peer sessions and online-only player creation`.

### Task 9: Accessible share, player, restore, and table views

**Files:** Create `src/ui/share.ts`, `src/ui/player.ts`, `src/ui/table.ts`, `src/ui/restore-game.ts`, `tests/ui/share.test.ts`, `tests/ui/player.test.ts`, `tests/ui/table.test.ts`, `tests/ui/restore-game.test.ts`; adjust `src/ui/styles.css` only for these views.

**Interfaces:** Each view returns `{update(data):void;destroy():void}` typed with that view's data. `createShareView(root:HTMLElement, data:{mode:'open'|'join'|'active';link:string|null;message:string;canConnect:boolean}, actions:{connect():void;cancel():void})`; `createPlayerView(root:HTMLElement, data:{game:Game;selectedId:string|null;occupiedIds:string[];canCreate:boolean;message:string|null}, actions:{select(id:string):void;create(name:string,role:Role):void;cancel():void})`; `createTableView(root:HTMLElement,view:PeerSessionView,actions:{roll(sides:DieSides):void;download():void;downloadRecovery():void;connect():void;disconnect():void;leave():void;choosePlayer():void})`; `createRestoreGameView(root:HTMLElement,data:{snapshot:WorkspaceSnapshot;replace:boolean;selectedId:string|null},actions:{open(id:string):void;cancel():void})`. Export the concrete data/view types from those modules. No view imports storage/network controllers.

- [ ] **Step 1: Write failing jsdom view tests.** In `does not submit offline creation`, render createPlayerView with canCreate=false, dispatch a form submit programmatically, and assert `expect(create).not.toHaveBeenCalled()` and `expect(root.querySelector<HTMLButtonElement>('#create-player')!.disabled).toBe(true)`. Pin privacy consent with `expect(connect).not.toHaveBeenCalled()` before clicking; clipboard rejection with `expect(output.readOnly).toBe(true)` and selected output length; restore with `expect(root.querySelector('#restore-name')).toBeNull()`; escaped conflict values with `expect(root.querySelector('img')).toBeNull()`; focused updates with `expect(document.activeElement).toBe(roll)`. Also assert offline canRoll enables Roll, all participants can share an active link, recovery action exists when hasRecovery=true, and no Approve/Reject/reply-code control is rendered.
- [ ] **Step 2: Run red.** Run the four new UI test files; expect missing views, not changed legacy-app tests.
- [ ] **Step 3: Implement replaceable views.** Use existing `el`, `field`, `button`, `status` helpers. Keep public IDs `#roll`, `#die`, `#download`, `#leave`, `[data-roll]`, `.roster`; new IDs: `#open-room`, `#join-room`, `#room-link-output`, `#copy-room-link`, `#disconnect-room`, `#player-existing`, `#player-name`, `#player-role`, `#create-player`, `#download-recovery`. Announce connection/sync/offline/conflict/save statuses; do not equate signaling with loaded game. Show roster creation unavailable offline and no whole-game-winning message.
- [ ] **Step 4: Verify green.** New view tests plus existing UI suite/typecheck/build pass; old app still uses old views at this point. Check narrow-width styles and visible focus without unrelated reformatting.
- [ ] **Step 5: Commit.** Commit task view/test/style paths as `feat: add replaceable room-link and local-first player views`.

### Task 10: Cut the application over to asynchronous causal workspaces

**Files:** Modify `src/ui/app.ts`, `src/ui/start.ts`, `src/main.ts` only if bootstrap typing needs it; rewrite `tests/ui/connection.test.ts`, `tests/ui/connection-errors.test.ts`, `tests/ui/guest-save.test.ts`, `tests/ui/identity.test.ts`, `tests/ui/restore.test.ts`, `tests/ui/room.test.ts`, `tests/ui/start.test.ts`, `tests/ui/lifecycle.test.ts` around the approved behavior; create `tests/ui/autosave.test.ts`. Existing view-only legacy tests may be replaced by the corresponding Task 9 tests, with their retained regression intent documented in the commit.

**Interfaces:** Preserve `mountApp(root:HTMLElement,deps?:AppDependencies):{destroy():void}`. New dependencies: `repository?:WorkspaceRepository`, `runtime?:Runtime`, `parseFile?:(file:File)=>Promise<WorkspaceSnapshot>`, `download?:(snapshot:WorkspaceSnapshot)=>void`, `confirm?:(message:string)=>boolean`, existing Environment shape, and `createSession?:typeof createPeerSession`. `detectEnvironment()` feature-detects RTC/WebSocket/subtle crypto for connecting separately from local crypto/encoding support; absent IndexedDB is a persistence warning, not canCreate=false.

- [ ] **Step 1: Write failing app regressions against the new dependencies.** Use async `vi.waitFor`, not synchronous assumptions about indexed storage. Pin `slow earlier import cannot replace a newly created live game` to `expect(root.textContent).toContain('New live game')`; `old save resolves after leave/remount` must not alter new statuses or revive providers; `same-game incoming link preserves local fork/recovery`; replacement cancel leaves snapshot/history/version unchanged; BFCache return renders one saved-game start and no old room. Autosave tests assert every accepted generation is queued in order, never skipped because two peers have the same legacy revision, and stale-CAS warnings preserve the in-memory backup (Review Focus 1/2).
- [ ] **Step 2: Run red.** Run the changed/new UI tests and record the expected old host/manual/synchronous behavior failures.
- [ ] **Step 3: Wire new repository/session/views.** Await listing/loading with per-mount/import/session generation guards. Initial new game bootstraps once; local restore auto-selects an available remembered existing player and never adds another offline GM. Import preview still requires explicit replacement confirmation, including remembered users. Consume/remove room fragments without starting discovery until consent. Pass matching local history into a join; without local state wait for peers, never fetch a game from signaling. Persist only getSnapshot via an ordered per-game save chain carrying storage CAS versions; save recovery separately, keep it in memory if persistence fails, and remember player hints separately. Drain/coordinate prior same-game autosaves before import replacement rather than letting an old write clobber it.
- [ ] **Step 4: Preserve lifecycle and failure UX.** Use safe async callbacks after destroy, persistent unsaved/stale warnings, usable download/recovery, leave confirmation, URL revocation, provider/session teardown, and the existing pagehide/pageshow bootstrap. UI error strings must preserve actionable redacted failure reason. Update start labels to “Room link”/“Join room”; remove invitation/reply and host approval wiring. Do not add a sheet editor or global event bus.
- [ ] **Step 5: Verify green.** Run `npm run typecheck`, `npm test`, `npm run build`; all unit/DOM tests must pass before moving on. Assert importing after an active pending save and denying both storage APIs do not lose the usable local workspace. This is not a browser-compatibility pass.
- [ ] **Step 6: Commit.** Commit only application wiring/view labels and migrated/new UI tests as `feat: switch Gather to local-first shared room sessions`.

### Task 11: Real-browser acceptance, legacy retirement, and truthful documentation

**Files:** Modify `tests/e2e/helpers.ts`, `tests/e2e/connections.spec.ts`, `tests/e2e/games.spec.ts`, `tests/e2e/compatibility.spec.ts`, `README.md`, `docs/superpowers/yjs-design-progress.md`; create `tests/e2e/reconciliation.spec.ts`, `docs/superpowers/debugging/2026-11-01-yjs-browser-acceptance.md`. Update current-state paragraphs of `AGENTS.md` without discarding its approved rules or staging user work incidentally. After gates pass, delete unreferenced `src/network/peer.ts`, `src/network/signaling.ts`, `src/network/framing.ts`, `src/session/host.ts`, `src/session/guest.ts`, `src/session/messages.ts`, `src/session/types.ts`, `src/storage/files.ts`, `src/ui/connection.ts`, `src/ui/identity.ts`, `src/ui/restore.ts`, `src/ui/room.ts`. Migrate/retire old `tests/network/{peer,signaling,framing}.test.ts`, `tests/session/{host,integration,messages}.test.ts`, `tests/storage/files.test.ts`, and `tests/helpers/transport.ts` only after mapping preserved invariants to new tests. Keep legacy `src/storage/repository.ts` and its tests for migration/hints, not new game writes.

**Interfaces:** Replace e2e manual helpers with `openSharedRoom(page:Page):Promise<string>`, `joinSharedRoom(page:Page,link:string):Promise<void>`, `createConnectedPlayer(page:Page,name:string):Promise<void>`, existing `createGame`/`countRolls`, and `forkBackupFile(path:string,edit:LocalEdit,label:string):Promise<{name:string;mimeType:string;buffer:Buffer}>`. The last helper runs domain code in the test process to prepare valid shared-history files, which the app loads through its public file input; it is not an app debug mutation or a transport mock. Keep credentials transient in test memory and ignored traces; never publish raw links/traces.

- [ ] **Step 1: Write failing public-flow acceptance tests.** Preserve the seven current engine-direction scenarios and add Firefox↔WebKit directions if not already covered; each uses three isolated contexts and the same reusable link, automatic connected creation/claims, simultaneous/late rolls, and first-participant departure with continued play. Assert offline new-player action disabled, existing rolls remain usable, remembered rejoin auto-selection, duplicate names/claims recover safely, and last-local download remains available. Add shared-history offline forks imported through public UI: Bob Red then Carol Blue produces Alice Old with a detailed warning, independent player-field edits survive, successor Dave starts from current Red, and pre-merge recovery downloads retain losing offline history.
- [ ] **Step 2: Run red.** Run focused new browser cases with the actual public signaling config; record observed missing behavior separately from environmental traversal/service failures. No `.skip`, mocked provider, fake RTC, or changed ICE privacy flags.
- [ ] **Step 3: Complete regression matrix and retire only obsolete implementation.** Test version-2 file roundtrip and legacy import; canceled/invalid import; deny IndexedDB+localStorage together and each independently; missing RTC/WebSocket/subtle crypto feedback; keyboard/mobile layout; clipboard fallback; malformed/stale/wrong-game links; refresh/BFCache cleanup. Close only signaling WebSockets after channels open and prove peer data still flows. Inspect actual signaling publishes for encrypted handshake-only content, assert no game payload/plaintext or TURN configuration, and verify native-open counters in the provider gate. Remove old modules only when search/typecheck finds no imports and the old validation/framing/replay/storage/focus/failure regressions have replacement coverage. Do not delete an unproven new network case to obtain a pass.
- [ ] **Step 4: Run final gates and record exact output.** `npm run typecheck`; `npm test`; `npm run build`; `npm run test:e2e`. If binaries are missing use `npx playwright install chromium firefox webkit`, then rerun, not a mocked substitute. Record engine directions, pass/fail counts, phase/error, tested endpoint/operator/date, and redacted network limitations in the acceptance note and README. Real Safari/Chrome, branded Edge/Firefox, and different-home-network smoke tests remain explicitly unrun unless actually performed. A partial matrix is not a fully green browser gate.
- [ ] **Step 5: Update documentation and commit.** Explain one-link joining, public signaling/STUN metadata visibility, no gameplay relay/storage/TURN, local/online-only player distinction, initial bootstrap, first-participant conflict/tenure rules, automatic identities, IndexedDB/recovery/causal JSON backups, legacy limited-history warnings, finite history budget, room lifetime, and exact acceptance results. Update the old current host-only/no-signaling claims in AGENTS.md in place, preserving examples. Stage only owned source/test/doc changes; do not incidentally add the pre-existing untracked AGENTS.md. Commit `test: verify shared room flows and document Yjs migration limits`; report any remaining acceptance blocker rather than declaring the migration accepted.

## Plan self-review and execution handoff

- [x] **Spec coverage:** Tasks 1–2 own privacy/links/bounded Trystero transport and the real WSS/RTC gate; 3–4 own causal model/granular first-participant conflicts/legacy ambiguity; 5–6 own local saves/recovery/backups; 7–8 own logical succession/online additions/claims; 9–10 own accessible replaceable UI and lifecycle; 11 owns actual browser evidence, legacy retirement, and current documentation. No sheet/gameplay scope added.
- [x] **Step scan:** Rechecked the amended Task 2 files/interfaces/tests and downstream consumers. Task 1's room-link/config/limits contracts remain consumed; Task 2 preserves the `createRoomTransport` interface used by Task 8; Tasks 3–11 retain their existing data/API contracts. The revised provider gate remains an explicit pause before Task 3 if any public hook or all-path bound fails.
- [x] **Type consistency:** WorkspaceSnapshot/history are distinct from Game; storage versions are distinct from game revision and session saveGeneration; RoomLink is transient; old modules retain old types until cutover. Cross-task interfaces are defined above, not left as TBDs.
- [x] **Review Focus:** All five failure modes have named assertions in owning tasks; the race/history/connection cases are not deferred to an unspecified final review.
- [x] **Proportion:** Bodies are left to implementers; only contract/test examples and required framing/causal decisions are specified. The plan does not contain a second implementation transcript.
- [ ] User reviews this amended plan and confirms that it captures the approved Trystero Core/provider change. The user already selected subagent-driven execution and explicitly authorized the current main checkout.
- [x] Execution will continue in the current `main` checkout per explicit user direction, using subagent-driven development, TDD task-by-task, per-task reviews, and verification gates. Preserve the untracked project instructions; never stage `AGENTS.md` incidentally.

Recommendation: **Subagent-driven** (already selected). The migration has 11 reviewable units spanning causal data loss risks, native RTC, and storage/UI interfaces; an independent gate per unit is worth the extra contexts. Native remains a valid lower-cost/faster choice with one whole-branch review after implementation.
