import * as Y from 'yjs';
import { normalizeRecipients, validateChatImage } from '../game/chat';
import { makeRosterAddition } from '../game/history';
import { capturePriority, reconcileHistories } from '../game/reconcile';
import type { ConflictNotice, GameHistory, GameOperation, LocalEdit, WorkspaceSnapshot } from '../game/sync-types';
import type { DieSides, Role } from '../game/types';
import { check, id, role as roleValue, text } from '../game/validation';
import { createWorkspace, type Workspace } from '../game/workspace';
import { ACTION_TOKEN_BURST, ACTION_TOKEN_REFILL_PER_SECOND, EXPIRY_MS, HEARTBEAT_MS } from '../network/limits';
import { createRoomLink, type RoomLink } from '../network/room-link';
import { createRoomTransport, type RoomTransport } from '../network/room';
import { createMembership, type Membership, type MembershipEvent } from './membership';
import type { ChatDraft, PeerSession, PeerSessionOptions, PeerSessionPhase, PeerSessionView } from './peer-types';
import {
  clearTransientStage,
  createWorkspaceBridge,
  pruneStagedChat,
  publishChat,
  readClaimConfirmations,
  readControlEvents,
  readLiveImages,
  readRosterIntents,
  readStagedChat,
  readStagedHistory,
  removeLiveImage,
  removeRosterIntent,
  snapshotFromHistory,
  writeClaimConfirmation,
  writeControlEvent,
  writeLiveImage,
  writeRosterIntent,
  type RosterIntent,
  type WorkspaceBridge,
} from './workspace-bridge';

/**
 * The causal peer session orchestrator.
 *
 * One controller owns exactly three things and keeps them separate:
 * - one durable `Workspace` (causal game history; the only thing `getSnapshot()` exposes),
 * - one transient staging `Y.Doc` synced by the room transport (candidate records, the
 *   bounded control log, roster intents and claim confirmations — never persisted),
 * - one transient logical `Membership` (roster, tenure and priority — never persisted).
 *
 * The single local participant id is generated once, at controller creation, and is passed
 * as the workspace `replicaId` even when the workspace is first loaded from peers, so local
 * author ids and `priority.participantId` always align.
 *
 * Authority rules: only the active priority participant publishes current-tenure conflict
 * resolutions and executes roster additions/claim confirmations; a new player is created
 * only with active synchronized reachability confirmed by the priority participant, and an
 * offline or expired creation intent is never replayed. Public actions never throw through
 * DOM callbacks: failures surface in `view.error` and never mutate the accepted snapshot.
 */

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
/** Errors at a safe history bound get an actionable download/recovery warning. */
const limitPattern = /limit|bound|backup|frontier/i;

function validateLink(value: RoomLink): RoomLink {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid room link.');
  const link = value as unknown as Record<string, unknown>;
  check(link.version === 2, 'Unsupported room link version.');
  check(typeof link.roomId === 'string' && uuidPattern.test(link.roomId), 'Invalid room ID.');
  check(typeof link.secret === 'string' && secretPattern.test(link.secret), 'Invalid room secret.');
  return { version: 2, roomId: link.roomId, gameId: id(link.gameId), secret: link.secret };
}

function actionable(message: string): string {
  return limitPattern.test(message)
    ? `${message} Your accepted game is unchanged — download the recovery copy before continuing.`
    : message;
}

export function createPeerSession(options: PeerSessionOptions): PeerSession {
  const runtime = options.runtime;
  const now = options.now;
  const participantId = id(runtime.id());
  const openTransport = options.createTransport ?? createRoomTransport;

  const stage = new Y.Doc();
  const listeners = new Set<() => void>();

  let workspace: Workspace | null = options.initial ? createWorkspace(options.initial, runtime, participantId) : null;
  let bridge: WorkspaceBridge | null = workspace ? createWorkspaceBridge(stage, workspace) : null;
  let unsubWorkspace: (() => void) | null = workspace ? workspace.subscribe(onWorkspaceChange) : null;

  let transport: RoomTransport | null = null;
  let unsubTransport: (() => void) | null = null;
  let membership: Membership | null = null;
  let unsubMembership: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let link: RoomLink | null = null;
  let founder = false;

  let closed = false;
  let saveGeneration = 0;
  let recovery: WorkspaceSnapshot | null = null;
  let error: string | null = null;
  let conflicts: ConflictNotice[] = [];
  let localPlayerId: string | null = null;
  let remembered: string | null = typeof options.rememberedPlayerId === 'string' && options.rememberedPlayerId ? options.rememberedPlayerId : null;
  let onlinePlayerIds: string[] = [];
  let synced = false;
  let wasConnected = false;
  let requestId: string | null = null;
  let lastRequestAt = Number.NEGATIVE_INFINITY;
  let claimIntentFor: string | null = null;
  let publishPending = workspace !== null;
  let lastPublishedKey = '';
  let syncDirty = true;
  let teardownRequested = false;
  let tokens = ACTION_TOKEN_BURST;
  let tokenAt = now();

  // ── refresh loop ─────────────────────────────────────────────────────────────────────
  let refreshing = false;
  let dirty = false;

  function refresh() {
    if (closed) return;
    if (refreshing) { dirty = true; return; }
    refreshing = true;
    try {
      for (let guard = 0; guard < 32; guard++) {
        dirty = false;
        step();
        if (!dirty) break;
      }
    } finally {
      refreshing = false;
      if (teardownRequested) {
        teardownRequested = false;
        teardownTransport();
      }
    }
  }
  function emit() { for (const fn of [...listeners]) fn(); }
  function onExternal() {
    if (closed) return;
    syncDirty = true;
    refresh();
    emit();
  }
  stage.on('update', onExternal);

  function step() {
    const view = transport?.getView() ?? null;
    if (view && view.phase === 'connected' && view.openRtcConnections > 0) wasConnected = true;
    if (membership) {
      // A stale replay of our own leave must never retire the fresh admission after a rejoin;
      // our own leave was already applied imperatively when it was published.
      const events = readControlEvents(stage).filter(event => !(event.type === 'leave' && event.participantId === participantId));
      membership.observe(events, view && view.phase !== 'closed' ? view.presence : []);
      // Tick after observing so expiry and succession judge with the freshest local presence.
      membership.tick();
    }
    requestAdmission(view);
    bootstrap();
    if (syncDirty) {
      syncDirty = false;
      if (publishPending) publishLocal();
      admitCandidates();
    }
    // Chat merges after the game work: game history stays the priority data and admitted
    // records are the baseline before anything staged is mirrored back.
    syncChat();
    processIntents();
    applyRemembered();
    if (localPlayerId !== null && connected() && claimIntentFor !== localPlayerId) publishClaimIntent();
    projectClaims();
  }

  // ── connection facts ─────────────────────────────────────────────────────────────────
  function connected(): boolean {
    const view = transport?.getView();
    return view !== undefined && view.phase === 'connected' && view.openRtcConnections > 0;
  }
  function reachable(pid: string): boolean {
    if (pid === participantId) return true;
    const view = transport?.getView();
    if (!view || view.phase === 'closed' || view.phase === 'failed') return false;
    const seen = view.presence.find(entry => entry.id === pid);
    return seen !== undefined && now() - seen.seenAt <= EXPIRY_MS;
  }
  function isAdmitted(): boolean {
    return membership?.getView().members.some(member => member.id === participantId) ?? false;
  }

  // ── membership ───────────────────────────────────────────────────────────────────────
  function publishControl(event: MembershipEvent) {
    try {
      writeControlEvent(stage, event);
    } catch (e) {
      stageFailure(e);
    }
  }
  function requestAdmission(view: ReturnType<RoomTransport['getView']> | null) {
    if (!membership || !view || view.phase !== 'connected' || view.openRtcConnections === 0) return;
    if (isAdmitted()) { requestId = null; return; }
    if (requestId !== null && now() - lastRequestAt <= EXPIRY_MS) return;
    requestId = runtime.id();
    lastRequestAt = now();
    publishControl({ type: 'admission-request', id: requestId, requesterId: participantId, at: now() });
  }

  // ── workspace lifecycle ──────────────────────────────────────────────────────────────
  function adopt(next: Workspace) {
    workspace = next;
    bridge = createWorkspaceBridge(stage, next);
    unsubWorkspace = next.subscribe(onWorkspaceChange);
    saveGeneration++;
    publishPending = true;
    syncDirty = true;
    dirty = true;
  }
  function bootstrap() {
    if (workspace || !link) return;
    const history = readStagedHistory(stage, link.gameId);
    if (!history) return;
    adopt(createWorkspace(snapshotFromHistory(history), runtime, participantId));
  }
  function onWorkspaceChange() {
    saveGeneration++;
    publishPending = true;
    syncDirty = true;
    refresh();
    emit();
  }
  function historyKey(history: GameHistory): string {
    return JSON.stringify([Object.keys(history.seeds).sort(), Object.keys(history.operations).sort()]);
  }
  function publishLocal() {
    if (!workspace || !bridge || !transport) return;
    const history = workspace.getHistory();
    try {
      bridge.publish(history);
      publishPending = false;
      lastPublishedKey = historyKey(history);
    } catch (e) {
      stageFailure(e);
    }
  }

  // ── reconciliation and admission ─────────────────────────────────────────────────────
  function hasNewContent(local: GameHistory, candidate: GameHistory): boolean {
    return Object.keys(candidate.seeds).some(key => !Object.hasOwn(local.seeds, key))
      || Object.keys(candidate.operations).some(key => !Object.hasOwn(local.operations, key));
  }
  function admitCandidates() {
    if (!workspace || !bridge) { synced = false; return; }
    const local = workspace.getHistory();
    let candidates: GameHistory[];
    try {
      candidates = bridge.readCandidates();
    } catch (e) {
      stageFailure(e);
      synced = false;
      return;
    }
    const fresh = candidates.some(candidate => hasNewContent(local, candidate));
    synced = !fresh;
    if (!fresh) return;
    const tenure = membership?.getView().tenure ?? null;
    const leader = tenure !== null && tenure.leaderId === participantId;
    // Freeze the pre-merge copy before admission: one recovery snapshot per game, kept in
    // memory so a failed or unwanted merge stays downloadable.
    const preMerge = workspace.getSnapshot();
    try {
      if (leader) {
        // Freeze the tenure baseline from the current accepted history on every round, so a
        // successor resolves from its own current version, never an expired fallback.
        const priority = capturePriority(local, participantId, tenure!.id);
        const reconciled = reconcileHistories([local, ...candidates], priority, runtime);
        recovery = preMerge;
        bridge.admit(reconciled.history);
        // Keep the last warning visible until a new conflict replaces it; a routine merge
        // must not erase the explanation before the participant has seen it.
        if (reconciled.notices.length) conflicts = reconciled.notices;
        // pendingIds carry no payloads; their records remain staged until dependencies arrive.
        bridge.publish(reconciled.history);
        publishPending = false;
        lastPublishedKey = historyKey(workspace.getHistory());
        error = null;
      } else {
        const stripped = candidates.map(candidate => stripForeignResolutions(candidate, local, tenure?.leaderId ?? null));
        recovery = preMerge;
        for (const candidate of stripped) bridge.admit(candidate);
        noteConflicts(local, candidates, tenure?.leaderId ?? null, tenure?.id ?? null);
        error = null;
      }
    } catch (e) {
      recovery = preMerge;
      const message = e instanceof Error ? e.message : 'The incoming game data could not be accepted.';
      if (leader || limitPattern.test(message)) error = actionable(message);
      // A non-leader merge blocked by an unresolved conflict is transient: the priority
      // participant's resolution is still on its way, so it is not surfaced as an error.
    }
  }
  /** Only the active priority participant publishes current-tenure resolutions. */
  function stripForeignResolutions(candidate: GameHistory, local: GameHistory, leaderId: string | null): GameHistory {
    const operations: Record<string, GameOperation> = {};
    for (const [key, operation] of Object.entries(candidate.operations)) {
      if (operation.type === 'resolution' && !Object.hasOwn(local.operations, key) && operation.authorId !== leaderId) continue;
      operations[key] = operation;
    }
    return { ...candidate, operations };
  }
  function noteConflicts(local: GameHistory, candidates: GameHistory[], leaderId: string | null, tenureId: string | null) {
    try {
      const priority = capturePriority(local, leaderId ?? participantId, tenureId ?? 'offline');
      const notices = reconcileHistories([local, ...candidates], priority, runtime).notices;
      if (notices.length) conflicts = notices;
    } catch {
      // Notices are best effort; they never block or fail an admission.
    }
  }
  function stageFailure(e: unknown) {
    // Staging/control encoded-limit failure: preserve the accepted workspace and close the
    // room (a shared Y.Doc overflow is not attributable to one peer channel). The teardown
    // is deferred so a failing publish inside a membership callback cannot destroy the
    // membership mid-call.
    error = actionable(e instanceof Error ? e.message : 'The room data could not be staged.');
    teardownRequested = true;
    syncDirty = true;
  }

  // ── durable chat mirror ──────────────────────────────────────────────────────────────
  /**
   * Admits staged chat into the durable workspace, then mirrors the canonical window back
   * to staging and prunes only records that were safely admitted. A failed merge leaves
   * staging untouched; a failed publish surfaces a normal error without tearing down the
   * room. Both writes are idempotent, so a settled stage is left byte-for-byte alone.
   */
  function syncChat() {
    if (!workspace) return;
    try {
      workspace.mergeMessages(readStagedChat(stage));
    } catch {
      return; // never publish or prune records that were not safely admitted
    }
    if (!transport) return;
    try {
      const messages = workspace.getMessages();
      publishChat(stage, messages);
      pruneStagedChat(stage, messages);
    } catch (e) {
      // Chat is durable after the local add; a mirror failure must not end the session.
      error = actionable(e instanceof Error ? e.message : 'Chat could not be synchronized.');
    }
  }

  // ── roster intents (creation and claims) ─────────────────────────────────────────────
  function processIntents() {
    if (!workspace || !bridge || !membership) return;
    const view = membership.getView();
    const tenure = view.tenure;
    if (!tenure || tenure.leaderId !== participantId || !connected() || !synced) return;
    const orderOf = (pid: string) => view.members.find(member => member.id === pid)?.order ?? Number.MAX_SAFE_INTEGER;
    const admitted = (pid: string) => view.members.some(member => member.id === pid);
    const fresh: RosterIntent[] = [];
    for (const intent of readRosterIntents(stage)) {
      if (now() - intent.at > EXPIRY_MS) {
        // An expired intent is dropped, never replayed later.
        removeRosterIntent(stage, intent.id);
        continue;
      }
      // Creation and claims are only valid with active synchronized reachability of an
      // admitted member, confirmed locally by the priority participant.
      if (!admitted(intent.participantId) || !reachable(intent.participantId)) continue;
      fresh.push(intent);
    }
    const game = workspace.getSnapshot().game;
    // Claims are confirmed first so GM authority is visible before additions are judged.
    const groups = new Map<string, typeof fresh>();
    for (const intent of fresh) {
      if (intent.type !== 'claim') continue;
      groups.set(intent.playerId, [...(groups.get(intent.playerId) ?? []), intent]);
    }
    const confirmations = new Map(readClaimConfirmations(stage).map(entry => [entry.playerId, entry]));
    for (const [playerId, group] of groups) {
      if (!game.players.some(player => player.id === playerId)) {
        for (const intent of group) removeRosterIntent(stage, intent.id);
        continue;
      }
      const existing = confirmations.get(playerId);
      if (existing && admitted(existing.participantId) && reachable(existing.participantId)) {
        for (const intent of group) removeRosterIntent(stage, intent.id);
        continue;
      }
      const winner = [...group].sort((a, b) => orderOf(a.participantId) - orderOf(b.participantId)
        || (a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0))[0];
      writeClaimConfirmation(stage, { playerId, participantId: winner.participantId, at: now() });
      for (const intent of group) removeRosterIntent(stage, intent.id);
      dirty = true;
    }
    // Additions are authorized only for the participant currently seated as the GM.
    const gmPlayerIds = new Set(game.players.filter(player => player.role === 'gm').map(player => player.id));
    const gmParticipants = new Set(
      readClaimConfirmations(stage)
        .filter(entry => gmPlayerIds.has(entry.playerId) && admitted(entry.participantId) && reachable(entry.participantId))
        .map(entry => entry.participantId),
    );
    const produced = new Set<string>();
    for (const intent of fresh) {
      if (intent.type !== 'add-player') continue;
      if (!gmParticipants.has(intent.participantId)) {
        // A claim confirmed in this pass is enough; a still-pending GM claim keeps the
        // addition waiting instead of dropping it before the claim resolves.
        const pendingGmClaim = fresh.some(other => other.type === 'claim'
          && other.participantId === intent.participantId && gmPlayerIds.has(other.playerId));
        if (!pendingGmClaim) removeRosterIntent(stage, intent.id);
        continue;
      }
      const dedupe = `${intent.participantId}\u0000${intent.name.trim().toLowerCase()}\u0000${intent.role}`;
      if (produced.has(dedupe)) { removeRosterIntent(stage, intent.id); continue; }
      produced.add(dedupe);
      try {
        const name = text(intent.name);
        const role = roleValue(intent.role);
        check(!game.players.some(player => player.name.toLowerCase() === name.toLowerCase()), 'Duplicate player ID or name.');
        check(game.players.length < 32, 'Games need 1–32 players.');
        const player = { id: id(runtime.id()), name, role };
        // The producer authors the addition; the priority participant only executes it.
        const operation = makeRosterAddition(workspace.getHistory(), player, runtime, intent.participantId);
        const local = workspace.getHistory();
        bridge.publish({ ...local, operations: { ...local.operations, [operation.id]: operation } });
        removeRosterIntent(stage, intent.id);
        game.players.push(player);
        syncDirty = true;
        dirty = true;
      } catch {
        // An invalid addition is rejected outright; accepted historical additions remain
        // replayable, but a rejected intent is never retried.
        removeRosterIntent(stage, intent.id);
      }
    }
  }
  function publishClaimIntent() {
    if (localPlayerId === null || claimIntentFor === localPlayerId || !connected()) return;
    const pending = readRosterIntents(stage).some(intent => intent.type === 'claim' && intent.participantId === participantId && intent.playerId === localPlayerId);
    if (!pending) {
      try {
        writeRosterIntent(stage, { id: runtime.id(), type: 'claim', participantId, playerId: localPlayerId, at: now() });
      } catch {
        return; // bounded: retried on a later refresh
      }
    }
    claimIntentFor = localPlayerId;
  }
  function applyRemembered() {
    if (!workspace || localPlayerId !== null || remembered === null) return;
    const owner = readClaimConfirmations(stage).find(entry => entry.playerId === remembered);
    if (owner && owner.participantId !== participantId && reachable(owner.participantId)) {
      // Another live participant owns it. Keep the preference (unlike a manual
      // selection) so a reconnecting owner can reclaim it after the old claim expires.
      return;
    }
    if (!workspace.getSnapshot().game.players.some(player => player.id === remembered)) return;
    localPlayerId = remembered;
    publishClaimIntent();
  }
  function projectClaims() {
    const confirmations = readClaimConfirmations(stage);
    onlinePlayerIds = confirmations.filter(entry => reachable(entry.participantId)).map(entry => entry.playerId)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (workspace && localPlayerId !== null && !workspace.getSnapshot().game.players.some(player => player.id === localPlayerId)) {
      localPlayerId = null;
      claimIntentFor = null;
    }
    if (localPlayerId !== null && transport) {
      const owner = confirmations.find(entry => entry.playerId === localPlayerId);
      if (owner && owner.participantId !== participantId && reachable(owner.participantId)) {
        localPlayerId = null;
        claimIntentFor = null;
        remembered = null;
        error = 'Another participant claimed this player first.';
      }
    }
  }

  // ── transport lifecycle ──────────────────────────────────────────────────────────────
  function startTransport(asFounder: boolean) {
    // Intents, confirmations and the local control log are per-connection: they must never
    // replay into a fresh connection. Authoritative control history flows back from peers.
    clearTransientStage(stage);
    transport = openTransport(stage, link!, participantId);
    unsubTransport = transport.subscribe(onExternal);
    membership = createMembership({ localId: participantId, founder: asFounder, now, id: runtime.id, publish: publishControl });
    unsubMembership = membership.subscribe(onExternal);
    requestId = null;
    lastRequestAt = Number.NEGATIVE_INFINITY;
    claimIntentFor = null;
    heartbeat = setInterval(() => { refresh(); emit(); }, HEARTBEAT_MS);
    (heartbeat as { unref?: () => void }).unref?.();
    publishLocal();
    syncDirty = true;
    refresh();
  }
  function teardownTransport() {
    if (heartbeat !== null) { clearInterval(heartbeat); heartbeat = null; }
    unsubTransport?.(); unsubTransport = null;
    unsubMembership?.(); unsubMembership = null;
    try { membership?.destroy(); } catch { /* already destroyed */ }
    membership = null;
    try { transport?.close(); } catch { /* already closed */ }
    transport = null;
    clearTransientStage(stage);
    requestId = null;
    claimIntentFor = null;
    synced = false;
  }

  // ── actions ──────────────────────────────────────────────────────────────────────────
  function takeToken(): boolean {
    const at = now();
    tokens = Math.min(ACTION_TOKEN_BURST, tokens + ((at - tokenAt) / 1000) * ACTION_TOKEN_REFILL_PER_SECOND);
    tokenAt = at;
    if (tokens < 1) return false;
    tokens--;
    return true;
  }
  /**
   * Public actions report failures in `view.error`; they never throw through DOM callbacks.
   * Returns whether the action was accepted, for callers that need the outcome.
   */
  function action(run: () => void): boolean {
    if (closed) { error = 'Session is closed.'; emit(); return false; }
    // Rate-limit user actions, never sync fragments.
    if (!takeToken()) { error = 'Too many actions; wait a moment and try again.'; emit(); return false; }
    let accepted = true;
    try {
      run();
      error = null;
    } catch (e) {
      accepted = false;
      error = actionable(e instanceof Error ? e.message : 'The action could not be completed.');
    }
    refresh();
    emit();
    return accepted;
  }
  function isLocalGm(): boolean {
    if (workspace === null || localPlayerId === null) return false;
    return workspace.getSnapshot().game.players.some(player => player.id === localPlayerId && player.role === 'gm');
  }
  function canCreatePlayerNow(): boolean {
    if (closed || workspace === null || !connected() || !synced) return false;
    if (!isLocalGm()) return false;
    const tenure = membership?.getView().tenure ?? null;
    if (!isAdmitted() || tenure === null) return false;
    return tenure.leaderId === participantId || reachable(tenure.leaderId);
  }
  function unseatedCount(): number {
    if (closed || workspace === null || transport === null || membership === null) return 0;
    const seated = new Set(readClaimConfirmations(stage)
      .filter(entry => reachable(entry.participantId))
      .map(entry => entry.participantId));
    return membership.getView().members
      .filter(member => member.id !== participantId && reachable(member.id) && !seated.has(member.id))
      .length;
  }

  const session: PeerSession = {
    getView(): PeerSessionView {
      refresh();
      const tenure = membership?.getView().tenure ?? null;
      const game = workspace && !closed ? workspace.getSnapshot().game : null;
      const seated = !closed && workspace !== null && localPlayerId !== null
        && (game?.players.some(player => player.id === localPlayerId) ?? false);
      return {
        game,
        phase: currentPhase(),
        localPlayerId,
        onlinePlayerIds: [...onlinePlayerIds],
        priorityParticipantId: tenure?.leaderId ?? null,
        canCreatePlayer: canCreatePlayerNow(),
        canRoll: seated,
        canChat: seated,
        messages: workspace && !closed ? workspace.getMessages() : [],
        liveImages: closed ? [] : readLiveImages(stage),
        hasRecovery: recovery !== null,
        hasRoomLink: !closed && link !== null,
        unseatedParticipantCount: unseatedCount(),
        conflicts: conflicts.map(notice => ({ ...notice })),
        error,
        connectionError: closed ? null : (transport?.getView().error ?? null),
        saveGeneration,
      };
    },
    getSnapshot() {
      if (closed || !workspace) return null;
      return workspace.getSnapshot();
    },
    getRecoverySnapshot() {
      return recovery;
    },
    getRoomLink() {
      return closed ? null : link;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    openRoom() {
      if (closed) { error = 'Session is closed.'; emit(); return null; }
      if (!workspace) { error = 'Create or load a game before opening a room.'; emit(); return null; }
      try {
        if (!link) { link = createRoomLink(workspace.getHistory().gameId); founder = true; }
        if (!transport) startTransport(founder);
        error = null;
      } catch (e) {
        error = actionable(e instanceof Error ? e.message : 'The room could not be opened.');
        emit();
        return null;
      }
      emit();
      return link;
    },
    joinRoom(value) {
      if (closed) { error = 'Session is closed.'; emit(); return; }
      try {
        const next = validateLink(value);
        if (transport) {
          check(link?.roomId === next.roomId, 'Leave the current room before joining another.');
          error = null;
          emit();
          return;
        }
        // A same-game link attaches the existing local edits; a wrong game fails safely.
        if (workspace) check(workspace.getHistory().gameId === next.gameId, 'Wrong game ID.');
        link = next;
        founder = false;
        startTransport(false);
        error = null;
      } catch (e) {
        error = actionable(e instanceof Error ? e.message : 'The room could not be joined.');
      }
      emit();
    },
    selectPlayer(playerId) {
      action(() => {
        const pid = id(playerId);
        check(workspace !== null, 'No game is loaded.');
        check(workspace.getSnapshot().game.players.some(player => player.id === pid), 'Unknown player reference.');
        remembered = null;
        localPlayerId = pid;
        claimIntentFor = null;
        // Offline (or pre-confirmation) selections stay local/unconfirmed.
        publishClaimIntent();
      });
    },
    createPlayer(name, role) {
      action(() => {
        check(isLocalGm(), 'Only the GM can add players.');
        check(canCreatePlayerNow(), 'Player creation requires an active, synchronized room connection.');
        const playerName = text(name);
        const playerRole = roleValue(role);
        const game = workspace!.getSnapshot().game;
        check(!game.players.some(player => player.name.toLowerCase() === playerName.toLowerCase()), 'Duplicate player ID or name.');
        check(game.players.length < 32, 'Games need 1–32 players.');
        // Transient, bounded and deduplicated: an identical pending intent is not repeated.
        const pending = readRosterIntents(stage).some(intent => intent.type === 'add-player' && intent.participantId === participantId
          && intent.name.trim().toLowerCase() === playerName.toLowerCase() && intent.role === playerRole);
        if (pending) return;
        writeRosterIntent(stage, { id: runtime.id(), type: 'add-player', participantId, name: playerName, role: playerRole, at: now() });
      });
    },
    sendMessage(draft: ChatDraft): boolean {
      return action(() => {
        // The seat is checked first: with no game there is still no player to post as.
        check(localPlayerId !== null, 'Choose your player first.');
        check(workspace !== null, 'No game is loaded.');
        const playerId = localPlayerId;
        const players = workspace.getSnapshot().game.players;
        check(players.some(player => player.id === playerId), 'Unknown player reference.');
        const body = typeof draft.text === 'string' ? draft.text.trim() : '';
        const image = draft.image;
        check(body.length > 0 || image !== undefined, 'Enter a message or attach an image.');
        const recipients = normalizeRecipients(draft.recipients, playerId);
        check(recipients === null || recipients.every(recipient => players.some(player => player.id === recipient)), 'Unknown chat recipient.');
        // One id and time for the draft: the live image and its durable caption share them.
        const messageId = id(runtime.id());
        const at = runtime.now();
        if (image !== undefined) {
          writeLiveImage(stage, validateChatImage({ ...image, id: messageId, playerId, at, recipients }));
          try {
            if (body.length > 0) workspace.addMessage({ id: messageId, playerId, at, text: body, recipients });
          } catch (e) {
            // Never leave an image whose caption was not saved; the draft stays retryable.
            removeLiveImage(stage, messageId);
            throw e;
          }
        } else {
          workspace.addMessage({ id: messageId, playerId, at, text: body, recipients });
        }
      });
    },
    roll(sides: DieSides) {
      action(() => {
        check(workspace !== null, 'No game is loaded.');
        check(localPlayerId !== null, 'Choose your player first.');
        workspace.applyLocal({ type: 'roll', playerId: localPlayerId, sides });
      });
    },
    edit(edit: LocalEdit) {
      action(() => {
        check(workspace !== null, 'No game is loaded.');
        workspace.applyLocal(edit);
      });
    },
    disconnect() {
      if (closed) { error = 'Session is closed.'; emit(); return; }
      // A graceful leave is best effort; peers expire the position on their own clocks.
      try { membership?.leave(); } catch { /* best effort */ }
      teardownTransport();
      // The workspace and the local selection are kept; the selection becomes unconfirmed.
      error = null;
      refresh();
      emit();
    },
    close() {
      if (closed) return;
      closed = true;
      teardownTransport();
      unsubWorkspace?.(); unsubWorkspace = null;
      stage.off('update', onExternal);
      bridge?.destroy(); bridge = null;
      workspace?.destroy(); workspace = null;
      stage.destroy();
      listeners.clear();
    },
  };

  function currentPhase(): PeerSessionPhase {
    if (closed) return 'closed';
    const view = transport?.getView() ?? null;
    if (!view) return 'local';
    if (view.phase === 'failed' || view.phase === 'closed') return 'offline';
    if (view.phase === 'looking' || view.openRtcConnections === 0) return wasConnected ? 'offline' : 'waiting';
    if (!workspace || !isAdmitted() || !synced) return 'syncing';
    return localPlayerId !== null ? 'ready' : 'choosing';
  }

  // Initialize derived state (remembered auto-select, synced flag) before the first view.
  refresh();
  return session;
}
