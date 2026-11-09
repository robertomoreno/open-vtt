import type { Game, Runtime } from '../game/types';
import { createGame } from '../game/model';
import { browserRuntime } from '../game/random';
import { createWorkspace, validateWorkspaceSnapshot } from '../game/workspace';
import type { WorkspaceSnapshot } from '../game/sync-types';
import { browserWorkspaceRepository, type WorkspaceRepository } from '../storage/workspace-repository';
import { parseBackupFile, downloadBackup } from '../storage/backups';
import { validateGame } from '../game/validation';
import { createPeerSession } from '../session/peer';
import type { ChatDraft, PeerSession } from '../session/peer-types';
import { decodeRoomLink, roomLink, type RoomLink } from '../network/room-link';
import { createStartView } from './start';
import { createRestoreGameView } from './restore-game';
import { createTableView, type TableView } from './table';
import { prepareChatImage } from './image';
import { createPlayerView, type PlayerView } from './player';
import { createShareView, type ShareView } from './share';
import { browserTabLocks, type TabLocks } from './tab-locks';
import { el, status } from './dom';

export type Environment = { canCreate: boolean; canConnect: boolean; message: string };
export function detectEnvironment(): Environment {
  const cryptoAvailable = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' && typeof crypto.getRandomValues === 'function';
  const textAvailable = typeof TextEncoder !== 'undefined' && typeof TextDecoder !== 'undefined';
  const subtleAvailable = typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';
  const rtcAvailable = typeof RTCPeerConnection !== 'undefined';
  const wsAvailable = typeof WebSocket !== 'undefined';
  const secure = globalThis.isSecureContext !== false;
  const canCreate = cryptoAvailable && textAvailable && secure;
  const canConnect = canCreate && subtleAvailable && rtcAvailable && wsAvailable;
  return {
    canCreate,
    canConnect,
    message: !canCreate
      ? 'Use HTTPS or localhost in a modern browser with Web Crypto and TextEncoder/TextDecoder.'
      : !canConnect
        ? 'WebRTC is unavailable. Use a current desktop browser over HTTPS or localhost to connect; local games still work.'
        : '',
  };
}

export type AppDependencies = {
  repository?: WorkspaceRepository;
  runtime?: Runtime;
  parseFile?: (file: File) => Promise<WorkspaceSnapshot>;
  download?: (snapshot: WorkspaceSnapshot) => void;
  confirm?: (message: string) => boolean;
  alert?: (message: string) => void;
  tabLocks?: TabLocks | null;
  environment?: Environment;
  createSession?: typeof createPeerSession;
  network?: any;
};

const mounts = new WeakMap<HTMLElement, { destroy(): void }>();

function normalizeSnapshot(value: any, runtime: Runtime): WorkspaceSnapshot {
  if (value && typeof value === 'object' && 'game' in value && 'history' in value) {
    return validateWorkspaceSnapshot({ game: value.game, history: value.history instanceof Uint8Array ? value.history : new Uint8Array(value.history) });
  }
  const game = validateGame(value);
  const workspace = createWorkspace(game, runtime);
  try {
    return workspace.getSnapshot();
  } finally {
    workspace.destroy();
  }
}

export function mountApp(root: HTMLElement, deps: AppDependencies = {}) {
  mounts.get(root)?.destroy();
  const runtime = deps.runtime ?? browserRuntime;
  const repository = deps.repository ?? browserWorkspaceRepository(runtime);
  const environment = deps.environment ?? detectEnvironment();
  const confirm = (message: string) => (deps.confirm ?? window.confirm)(message);
  const alert = (message: string) => (deps.alert ?? window.alert)(message);
  const tabLocks = deps.tabLocks === undefined ? browserTabLocks() : deps.tabLocks;

  const header = el('header');
  header.append(el('div', 'Gather', 'brand'), el('span', 'A small place for big adventures', 'eyebrow'));
  const warning = status();
  const error = status();
  const screen = el('div', '', 'screen');
  const flow = el('section');
  flow.id = 'connection-flow';
  root.replaceChildren(header, warning, error, flow, screen);

  let destroyed = false;
  let session: PeerSession | null = null;
  let releaseTabLock: (() => void) | null = null;
  let unsubscribe = () => {};
  let view: { destroy(): void } | null = null;
  let tableView: TableView | null = null;
  let playerView: PlayerView | null = null;
  let shareView: ShareView | null = null;
  let restoreView: any = null;
  let importGeneration = 0;
  let sessionToken = 0;
  let currentSaveGeneration = 0;
  let choosingPlayer = false;
  // Identity that was active when the manual chooser opened. A successful
  // selection (or an automatic one) must return the participant to the table;
  // otherwise the shared roll history stays hidden behind the chooser.
  let choosingFrom: string | null = null;
  let saveFailed = false;
  let inMemoryRecovery: WorkspaceSnapshot | null = null;
  let lastIdentity = '';

  type SaveChain = { gameId: string; expectedVersion: number; init: Promise<void>; tail: Promise<void>; lastQueued: number };
  const saveChains = new Map<string, SaveChain>();

  function createSaveChain(gameId: string): SaveChain {
    const chain: SaveChain = { gameId, expectedVersion: 0, init: Promise.resolve(), tail: Promise.resolve(), lastQueued: 0 };
    chain.init = repository.load(gameId).then((result: any) => {
      if (result && typeof result.version === 'number') chain.expectedVersion = result.version;
    }).catch(() => {});
    saveChains.set(gameId, chain);
    return chain;
  }

  function getSaveChain(gameId: string): SaveChain {
    return saveChains.get(gameId) ?? createSaveChain(gameId);
  }

  async function drainSaves(gameId: string) {
    const chain = saveChains.get(gameId);
    if (chain) {
      try { await chain.tail; } catch {}
    }
  }

  function report(e: unknown) {
    error.textContent = e instanceof Error ? e.message : String(e);
  }

  function clearFlow() {
    shareView?.destroy();
    shareView = null;
    flow.replaceChildren();
  }

  function clearViews() {
    view?.destroy();
    view = null;
    tableView = null;
    playerView = null;
    shareView = null;
    restoreView = null;
    screen.replaceChildren();
  }

  function clearSession() {
    releaseTabLock?.();
    releaseTabLock = null;
    unsubscribe();
    unsubscribe = () => {};
    session?.close();
    session = null;
    tableView = null;
    playerView = null;
    shareView = null;
    restoreView = null;
    currentSaveGeneration = 0;
    saveFailed = false;
    inMemoryRecovery = null;
    lastIdentity = '';
    choosingPlayer = false;
    choosingFrom = null;
  }

  function initSaveChain(gameId: string) {
    if (!saveChains.has(gameId)) createSaveChain(gameId);
  }

  function enqueueSave(gameId: string, generation: number, snapshot: WorkspaceSnapshot) {
    const chain = getSaveChain(gameId);
    if (generation <= chain.lastQueued) return;
    chain.lastQueued = generation;
    const thisToken = sessionToken;
    const task = async () => {
      await chain.init;
      if (destroyed || sessionToken !== thisToken) return;
      const result = await repository.save(snapshot, chain.expectedVersion);
      if (destroyed || sessionToken !== thisToken) return;
      if (result && result.ok) {
        chain.expectedVersion = result.version;
        saveFailed = false;
      } else {
        saveFailed = true;
        inMemoryRecovery = snapshot;
        const message = result?.message ?? 'Save failed.';
        if (result?.reason === 'stale') {
          warning.textContent = `${message} Your in-memory copy is preserved; download a recovery copy.`;
        } else {
          warning.textContent = message;
        }
      }
      const recoveryResult = await repository.saveRecovery(snapshot);
      if (destroyed || sessionToken !== thisToken) return;
      if (!recoveryResult || !recoveryResult.ok) {
        inMemoryRecovery = snapshot;
      }
    };
    chain.tail = chain.tail.then(task, task);
  }

  function openSession(next: PeerSession, gameId: string) {
    importGeneration++;
    sessionToken++;
    const thisToken = sessionToken;
    clearSession();
    session = next;
    releaseTabLock = tabLocks?.hold(gameId) ?? null;
    clearViews();
    unsubscribe = next.subscribe(() => {
      if (!destroyed && sessionToken === thisToken) renderSession();
    });
    renderSession();
  }

  function openHost(snapshot: WorkspaceSnapshot, playerId: string) {
    const remembered = repository.rememberedPlayer ? repository.rememberedPlayer(snapshot.game.id) : null;
    const create = deps.createSession ?? createPeerSession;
    const next = create({
      initial: snapshot,
      rememberedPlayerId: typeof remembered === 'string' ? remembered : null,
      runtime,
      now: () => Date.now(),
    });
    if (playerId && !next.getView().localPlayerId) {
      try { next.selectPlayer(playerId); } catch {}
    }
    openSession(next, snapshot.game.id);
    initSaveChain(snapshot.game.id);
    if (playerId) {
      try {
        const result = repository.rememberPlayer ? repository.rememberPlayer(snapshot.game.id, playerId) : { ok: true };
        if (result && !result.ok) warning.textContent = (result as { message: string }).message;
      } catch {}
    }
  }

  function showRestore(snapshot: WorkspaceSnapshot, replace: boolean, rememberedId: string | null) {
    importGeneration++;
    clearViews();
    clearFlow();
    restoreView = createRestoreGameView(screen, { snapshot, replace, selectedId: rememberedId ?? snapshot.game.players[0]?.id ?? null }, {
      open(playerId: string) {
        if (destroyed) return;
        const gen = importGeneration;
        (async () => {
          await drainSaves(snapshot.game.id);
          if (destroyed || gen !== importGeneration) return;
          openHost(snapshot, playerId || snapshot.game.players[0]?.id || '');
        })().catch((e) => { if (!destroyed && gen === importGeneration) report(e); });
      },
      cancel() { showStart(); },
    });
    view = restoreView;
  }

  function showJoining() {
    clearViews();
    clearFlow();
    screen.replaceChildren(
      el('p', 'Your party’s shared space', 'eyebrow'),
      el('h1', 'Joining the table…'),
      el('p', 'Connecting directly to the game. Keep this tab open.', 'lead'),
    );
  }

  function handleJoin(link: RoomLink) {
    if (!environment.canConnect) {
      report(new Error(environment.message));
      showStart();
      return;
    }
    if (session) {
      const current = session.getRoomLink();
      if (current && current.roomId === link.roomId && current.gameId === link.gameId) {
        session.joinRoom(link);
        renderSession();
        return;
      }
    }
    const gen = ++importGeneration;
    warning.textContent = environment.message;
    error.textContent = '';
    showJoining();
    (async () => {
      const loaded = await repository.load(link.gameId);
      if (destroyed || gen !== importGeneration) return;
      const snapshot = loaded && loaded.snapshot ? loaded.snapshot : null;
      const create = deps.createSession ?? createPeerSession;
      const next = create({
        initial: snapshot,
        rememberedPlayerId: repository.rememberedPlayer ? repository.rememberedPlayer(link.gameId) : null,
        runtime,
        now: () => Date.now(),
      });
      next.joinRoom(link);
      if (destroyed || gen !== importGeneration) { next.close(); return; }
      openSession(next, link.gameId);
      initSaveChain(link.gameId);
    })().catch((e) => {
      if (!destroyed && gen === importGeneration) {
        report(e);
        showStart();
      }
    });
  }

  async function handleImport(file: File) {
    const generation = ++importGeneration;
    try {
      const result = deps.parseFile ? await deps.parseFile(file) : await parseBackupFile(file, runtime);
      const snapshot = normalizeSnapshot(result, runtime);
      if (destroyed || generation !== importGeneration) return;
      await drainSaves(snapshot.game.id);
      if (destroyed || generation !== importGeneration) return;
      const loaded = await repository.load(snapshot.game.id);
      if (destroyed || generation !== importGeneration) return;
      const replace = !!(loaded && loaded.snapshot);
      showRestore(snapshot, replace, repository.rememberedPlayer ? repository.rememberedPlayer(snapshot.game.id) : null);
    } catch (e) {
      if (!destroyed && generation === importGeneration) report(e);
    }
  }

  function leave() {
    if (saveFailed && !confirm('This game has not been saved. Download a JSON copy before leaving. Leave anyway?')) return;
    sessionToken++;
    clearFlow();
    clearSession();
    showStart();
  }

  function showShare() {
    clearFlow();
    if (!session) return;
    if (!environment.canConnect) {
      report(new Error(environment.message));
      return;
    }
    const phase = session.getView().phase;
    const reconnect = phase === 'local' || phase === 'offline';
    let link = session.getRoomLink();
    if (!link || reconnect) link = session.openRoom();
    const currentLink = link ? roomLink(link, location.href) : null;
    const message = currentLink ? 'Room open. Preparing the link…' : (session.getView().error ?? 'The room could not be opened.');
    shareView = createShareView(flow, { link: currentLink, message }, {
      cancel() { clearFlow(); },
    });
    if (currentLink) void shareView.copy();
  }

  function renderSession() {
    if (!session || destroyed) return;
    const state = session.getView();
    const game = state.game;
    // A manual chooser is only a temporary detour: as soon as the local identity
    // changes (explicit selection, remembered auto-select, or a confirmed claim),
    // return to the shared table so its roll history is visible to this participant.
    if (choosingPlayer && state.localPlayerId !== null && state.localPlayerId !== choosingFrom) {
      choosingPlayer = false;
      choosingFrom = null;
    }

    if (game && state.saveGeneration !== currentSaveGeneration) {
      const snapshot = session.getSnapshot();
      if (snapshot) {
        currentSaveGeneration = state.saveGeneration;
        enqueueSave(game.id, state.saveGeneration, snapshot);
      }
    }

    if (game && state.localPlayerId && state.phase === 'ready') {
      const key = `${game.id}:${state.localPlayerId}`;
      if (key !== lastIdentity) {
        lastIdentity = key;
        try {
          const result = repository.rememberPlayer ? repository.rememberPlayer(game.id, state.localPlayerId) : { ok: true };
          if (result && !result.ok) warning.textContent = (result as { message: string }).message;
        } catch {}
      }
    }

    const recoverySnap = session.getRecoverySnapshot();
    if (recoverySnap) inMemoryRecovery = recoverySnap;

    // The player chooser renders its own status; do not duplicate the same live
    // error in both places (screen readers would announce it twice).
    const playerChooserOpen = Boolean(game) && (choosingPlayer || state.phase === 'choosing');
    if (state.error && !playerChooserOpen) error.textContent = state.error;
    else error.textContent = '';

    if (choosingPlayer || state.phase === 'choosing' || !game) {
      if (game) {
        if (!playerView) {
          tableView = null;
          playerView = createPlayerView(screen, {
            game,
            selectedId: state.localPlayerId,
            occupiedIds: state.onlinePlayerIds,
            canCreate: state.canCreatePlayer,
            message: state.error ?? state.connectionError,
          }, {
            select(id: string) {
              session?.selectPlayer(id);
              // Selecting the identity that is already local also means the
              // chooser has served its purpose; close it on any accepted pick.
              if (session?.getView().localPlayerId === id) {
                choosingPlayer = false;
                choosingFrom = null;
              }
              renderSession();
            },
            create(name: string, role: any) { session?.createPlayer(name, role); },
            cancel() {
              choosingPlayer = false;
              choosingFrom = null;
              playerView?.destroy();
              playerView = null;
              renderSession();
            },
          });
          view = playerView;
        } else {
          playerView.update({
            game,
            selectedId: state.localPlayerId,
            occupiedIds: state.onlinePlayerIds,
            canCreate: state.canCreatePlayer,
            message: state.error ?? state.connectionError,
          });
        }
      } else {
        if (!tableView) {
          playerView = null;
          tableView = createTableView(screen, state, tableActions());
          view = tableView;
        } else {
          tableView.update(state);
        }
      }
    } else {
      choosingPlayer = false;
      choosingFrom = null;
      if (playerView) {
        playerView.destroy();
        playerView = null;
      }
      if (!tableView) {
        tableView = createTableView(screen, state, tableActions());
        view = tableView;
      } else {
        tableView.update(state);
      }
    }

    if (saveFailed) {
      warning.textContent = warning.textContent || 'Save failed. Download a recovery copy.';
    }
  }

  function tableActions() {
    return {
      roll: (sides: any) => { session?.roll(sides); },
      download: () => {
        const snapshot = session?.getSnapshot();
        if (snapshot) try { (deps.download ?? downloadBackup)(snapshot); } catch (e) { report(e); }
      },
      downloadRecovery: () => {
        const snapshot = inMemoryRecovery ?? session?.getRecoverySnapshot() ?? session?.getSnapshot();
        if (snapshot) try { (deps.download ?? downloadBackup)(snapshot); } catch (e) { report(e); }
      },
      share: () => { showShare(); },
      disconnect: () => { session?.disconnect(); clearFlow(); },
      leave: () => { leave(); },
      choosePlayer: () => {
        choosingPlayer = true;
        choosingFrom = session?.getView().localPlayerId ?? null;
        renderSession();
      },
      createPlayer: (name: string, role: any) => { session?.createPlayer(name, role); },
      sendMessage: (draft: ChatDraft) => session?.sendMessage(draft) ?? false,
      prepareImage: (file: File) => prepareChatImage(file),
    };
  }

  async function showStart() {
    importGeneration++;
    const gen = importGeneration;
    clearViews();
    clearFlow();
    let listed: any;
    try {
      listed = await repository.list();
    } catch (e) {
      if (!destroyed) report(e);
      return;
    }
    if (destroyed || gen !== importGeneration) return;
    const data = { games: listed.games ?? [], warnings: listed.warnings ?? [], canCreate: environment.canCreate, canConnect: environment.canConnect };
    view = createStartView(screen, data, {
      create(name: string, creator: string) {
        try {
          if (!environment.canCreate) throw new Error(environment.message);
          const game = createGame(name, creator, runtime);
          const workspace = createWorkspace(game, runtime);
          const snapshot = workspace.getSnapshot();
          workspace.destroy();
          openHost(snapshot, game.players[0].id);
        } catch (e) {
          report(e);
        }
      },
      restore(game: Game) {
        const gen = importGeneration;
        (async () => {
          const loaded = await repository.load(game.id);
          if (destroyed || gen !== importGeneration) return;
          const snapshot = loaded && loaded.snapshot ? loaded.snapshot : normalizeSnapshot(game, runtime);
          if (destroyed || gen !== importGeneration) return;
          showRestore(snapshot, false, repository.rememberedPlayer ? repository.rememberedPlayer(game.id) : null);
        })().catch((e) => { if (!destroyed && gen === importGeneration) report(e); });
      },
      async remove(game: Game) {
        try {
          if (tabLocks) {
            const busy = await tabLocks.isBusy(game.id);
            if (destroyed || gen !== importGeneration) return;
            if (busy) {
              alert(`“${game.name}” is open in another tab. Close it there before deleting it.`);
              return;
            }
          }
          if (!confirm(`Delete “${game.name}” and its entire history from this browser? This cannot be undone.`)) return;
          if (destroyed || gen !== importGeneration) return;
          await drainSaves(game.id);
          if (destroyed || gen !== importGeneration) return;
          const result = await repository.remove(game.id);
          if (destroyed || gen !== importGeneration) return;
          if (!result.ok) { report(new Error(result.message)); return; }
          saveChains.delete(game.id);
          await showStart();
        } catch (e) {
          if (!destroyed && gen === importGeneration) report(e);
        }
      },
      import(file: File) { handleImport(file); },
    });
    warning.textContent = environment.message;
    if (listed.warnings && listed.warnings.length) {
      warning.textContent = [environment.message, ...listed.warnings].filter(Boolean).join(' ');
    }
  }

  function consumeHash(): boolean {
    if (!location.hash) return false;
    const full = location.href;
    history.replaceState(null, '', location.pathname + location.search);
    let link: RoomLink;
    try {
      link = decodeRoomLink(full);
    } catch (e) {
      report(e);
      return false;
    }
    handleJoin(link);
    return true;
  }

  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (saveFailed && session) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  window.addEventListener('hashchange', consumeHash);

  const app = {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      importGeneration++;
      sessionToken++;
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('hashchange', consumeHash);
      clearFlow();
      clearSession();
      view?.destroy();
      root.replaceChildren();
      mounts.delete(root);
    },
  };
  mounts.set(root, app);

  if (!consumeHash()) showStart();
  return app;
}