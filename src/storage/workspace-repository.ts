import type { Game, Runtime } from '../game/types';
import type { WorkspaceSnapshot } from '../game/sync-types';
import { createWorkspace, validateWorkspaceSnapshot } from '../game/workspace';
import { AUDIO_BYTES } from '../network/limits';
import { createRepository, type SaveResult } from './repository';

export type WorkspaceSaveResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'storage' | 'stale'; message: string };

export type WorkspaceRepository = {
  list(): Promise<{ games: Game[]; warnings: string[] }>;
  load(id: string): Promise<{ snapshot: WorkspaceSnapshot | null; version: number; warnings: string[] }>;
  save(snapshot: WorkspaceSnapshot, expectedVersion: number): Promise<WorkspaceSaveResult>;
  remove(id: string): Promise<SaveResult>;
  saveRecovery(snapshot: WorkspaceSnapshot): Promise<SaveResult>;
  loadRecovery(id: string): Promise<WorkspaceSnapshot | null>;
  rememberedPlayer(id: string): string | null;
  rememberPlayer(gameId: string, playerId: string): SaveResult;
  putAudio(gameId: string, trackId: string, bytes: ArrayBuffer): Promise<SaveResult>;
  getAudio(gameId: string, trackId: string): Promise<ArrayBuffer | null>;
  hasAudio(gameId: string, trackId: string): Promise<boolean>;
  removeAudio(gameId: string, trackId: string): Promise<void>;
  removeGameAudio(gameId: string): Promise<void>;
  listAudio(gameId: string): Promise<string[]>;
  close(): void;
};

const DB_NAME = 'gather-workspaces';
const DB_VERSION = 2;
const GAMES_STORE = 'games';
const RECOVERY_STORE = 'recovery';
const AUDIO_STORE = 'audio';
const AUDIO_INDEX = 'gameId';
const BLOCKED_TIMEOUT_MS = 1000;
const STORAGE_WARNING = 'Browser save unavailable. Your game is still in memory; download a JSON copy to keep it.';
const CORRUPT_WARNING = 'A corrupt browser save was skipped. Other saves are still available.';
const MIGRATION_WARNING = 'A saved game could not be moved to durable storage; a temporary in-memory copy is still usable.';

type RecoveryRecord = { id: string; snapshot: WorkspaceSnapshot };
type AudioRecord = { key: string; gameId: string; trackId: string; bytes: ArrayBuffer; size: number; savedAt: string };

const AUDIO_ID = /^[0-9a-f]{64}$/;

function isGameId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && value.trim() === value;
}

function audioKey(gameId: unknown, trackId: unknown): string | null {
  return isGameId(gameId) && typeof trackId === 'string' && AUDIO_ID.test(trackId) ? `${gameId}:${trackId}` : null;
}

function deniedStorage(): Storage {
  return new Proxy({} as Storage, { get() { throw new Error('Storage unavailable'); } });
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(0);
}

export function createWorkspaceRepository(options: {
  indexedDB?: IDBFactory;
  storage?: Storage;
  runtime: Runtime;
  dbName?: string;
}): WorkspaceRepository {
  const { runtime } = options;
  const indexedDB = options.indexedDB ?? null;
  const dbName = options.dbName ?? DB_NAME;
  const legacy = createRepository(options.storage ?? deniedStorage());

  let db: IDBDatabase | null = null;
  let openPromise: Promise<IDBDatabase> | null = null;
  let unavailable = false;
  let closed = false;

  function openDatabase(): Promise<IDBDatabase> {
    if (!indexedDB) { unavailable = true; return Promise.reject(new Error('IndexedDB unavailable')); }
    return new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(dbName, DB_VERSION);
      } catch (error) {
        unavailable = true;
        reject(error instanceof Error ? error : new Error('IndexedDB open failed'));
        return;
      }
      let blockedTimer: ReturnType<typeof setTimeout> | undefined;
      request.onupgradeneeded = () => {
        const fresh = request.result;
        if (!fresh.objectStoreNames.contains(GAMES_STORE)) fresh.createObjectStore(GAMES_STORE, { keyPath: 'id' });
        if (!fresh.objectStoreNames.contains(RECOVERY_STORE)) fresh.createObjectStore(RECOVERY_STORE, { keyPath: 'id' });
        if (!fresh.objectStoreNames.contains(AUDIO_STORE)) fresh.createObjectStore(AUDIO_STORE, { keyPath: 'key' }).createIndex(AUDIO_INDEX, 'gameId');
      };
      request.onblocked = () => {
        blockedTimer = setTimeout(() => {
          unavailable = true;
          reject(new Error('IndexedDB open blocked'));
        }, BLOCKED_TIMEOUT_MS);
      };
      request.onsuccess = () => {
        if (blockedTimer) clearTimeout(blockedTimer);
        const handle = request.result;
        if (closed || unavailable) {
          try { handle.close(); } catch {}
          reject(new Error('Workspace storage unavailable'));
          return;
        }
        handle.onversionchange = () => { handle.close(); db = null; openPromise = null; };
        db = handle;
        resolve(handle);
      };
      request.onerror = () => {
        if (blockedTimer) clearTimeout(blockedTimer);
        unavailable = true;
        reject(request.error ?? new Error('IndexedDB open failed'));
      };
    });
  }

  function ensureDb(): Promise<IDBDatabase> {
    if (closed || unavailable) return Promise.reject(new Error('Workspace storage unavailable'));
    if (db) return Promise.resolve(db);
    if (!openPromise) openPromise = openDatabase().catch(error => { openPromise = null; throw error; });
    return openPromise;
  }

  function getOne<T>(handle: IDBDatabase, storeName: string, id: string): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = handle.transaction(storeName, 'readonly'); } catch (error) { reject(error); return; }
      let result: T | undefined;
      let settled = false;
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error instanceof Error ? error : new Error('Read failed')); } };
      const request = tx.objectStore(storeName).get(id);
      request.onsuccess = () => { result = request.result as T | undefined; };
      request.onerror = () => fail(request.error);
      tx.oncomplete = () => { if (!settled) { settled = true; resolve(result); } };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error);
    });
  }

  function getAll<T>(handle: IDBDatabase, storeName: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = handle.transaction(storeName, 'readonly'); } catch (error) { reject(error); return; }
      let result: T[] = [];
      let settled = false;
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error instanceof Error ? error : new Error('Read failed')); } };
      const request = tx.objectStore(storeName).getAll();
      request.onsuccess = () => { result = request.result as T[]; };
      request.onerror = () => fail(request.error);
      tx.oncomplete = () => { if (!settled) { settled = true; resolve(result); } };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error);
    });
  }

  function getIndexKeys(handle: IDBDatabase, storeName: string, indexName: string, query: IDBValidKey): Promise<IDBValidKey[]> {
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = handle.transaction(storeName, 'readonly'); } catch (error) { reject(error); return; }
      let result: IDBValidKey[] = [];
      let settled = false;
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error instanceof Error ? error : new Error('Read failed')); } };
      const request = tx.objectStore(storeName).index(indexName).getAllKeys(query);
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => fail(request.error);
      tx.oncomplete = () => { if (!settled) { settled = true; resolve(result); } };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error);
    });
  }

  function countOne(handle: IDBDatabase, storeName: string, query: IDBValidKey): Promise<number> {
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = handle.transaction(storeName, 'readonly'); } catch (error) { reject(error); return; }
      let result = 0;
      let settled = false;
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error instanceof Error ? error : new Error('Read failed')); } };
      const request = tx.objectStore(storeName).count(query);
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => fail(request.error);
      tx.oncomplete = () => { if (!settled) { settled = true; resolve(result); } };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error);
    });
  }

  function putOne(handle: IDBDatabase, storeName: string, value: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = handle.transaction(storeName, 'readwrite'); } catch (error) { reject(error); return; }
      let settled = false;
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error instanceof Error ? error : new Error('Write failed')); } };
      try {
        tx.objectStore(storeName).put(value);
      } catch (error) { try { tx.abort(); } catch {} fail(error); return; }
      tx.oncomplete = () => { if (!settled) { settled = true; resolve(); } };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error);
    });
  }

  function casSave(handle: IDBDatabase, id: string, expectedVersion: number, snapshot: WorkspaceSnapshot): Promise<number | null> {
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = handle.transaction(GAMES_STORE, 'readwrite'); } catch (error) { reject(error); return; }
      const store = tx.objectStore(GAMES_STORE);
      let stale = false;
      let settled = false;
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error instanceof Error ? error : new Error('Save failed')); } };
      const get = store.get(id);
      get.onsuccess = () => {
        const parsed = parseRecord(get.result);
        const current = parsed === 'corrupt' ? 0 : parsed.version;
        if (current !== expectedVersion) { stale = true; return; }
        try {
          store.put({ id, version: current + 1, snapshot });
        } catch (error) { try { tx.abort(); } catch {} fail(error); }
      };
      get.onerror = () => fail(get.error);
      tx.oncomplete = () => { if (!settled) { settled = true; resolve(stale ? null : expectedVersion + 1); } };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error);
    });
  }

  function parseRecord(record: unknown): { id: string; version: number; snapshot: WorkspaceSnapshot } | 'corrupt' {
    if (record === null || typeof record !== 'object') return 'corrupt';
    const candidate = record as { id?: unknown; version?: unknown; snapshot?: unknown };
    if (typeof candidate.id !== 'string' || !Number.isSafeInteger(candidate.version) || (candidate.version as number) < 1) return 'corrupt';
    const raw = candidate.snapshot as { game?: unknown; history?: unknown } | undefined;
    if (!raw || typeof raw !== 'object') return 'corrupt';
    try {
      const snapshot = validateWorkspaceSnapshot({ game: raw.game as Game, history: toUint8Array(raw.history) });
      return snapshot.game.id === candidate.id ? { id: candidate.id, version: candidate.version as number, snapshot } : 'corrupt';
    } catch { return 'corrupt'; }
  }

  async function list(): Promise<{ games: Game[]; warnings: string[] }> {
    const warnings: string[] = [];
    const games = new Map<string, Game>();
    try {
      const handle = await ensureDb();
      const records = await getAll<unknown>(handle, GAMES_STORE);
      for (const record of records) {
        const parsed = parseRecord(record);
        if (parsed === 'corrupt') warnings.push(CORRUPT_WARNING);
        else games.set(parsed.id, parsed.snapshot.game);
      }
    } catch { warnings.push(STORAGE_WARNING); }
    const legacyList = legacy.list();
    for (const game of legacyList.games) if (!games.has(game.id)) games.set(game.id, game);
    for (const warning of legacyList.warnings) if (warning !== STORAGE_WARNING) warnings.push(warning);
    return { games: [...games.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), warnings };
  }

  async function load(id: string): Promise<{ snapshot: WorkspaceSnapshot | null; version: number; warnings: string[] }> {
    const warnings: string[] = [];
    let idbAvailable = true;
    try {
      const handle = await ensureDb();
      const record = await getOne<unknown>(handle, GAMES_STORE, id);
      if (record !== undefined) {
        const parsed = parseRecord(record);
        if (parsed !== 'corrupt') return { snapshot: parsed.snapshot, version: parsed.version, warnings };
        warnings.push(CORRUPT_WARNING);
      }
    } catch { idbAvailable = false; }
    const legacyGame = legacy.get(id);
    if (legacyGame) {
      let snapshot: WorkspaceSnapshot;
      try {
        const workspace = createWorkspace(legacyGame, runtime);
        snapshot = workspace.getSnapshot();
        workspace.destroy();
      } catch { warnings.push(CORRUPT_WARNING); return { snapshot: null, version: 0, warnings }; }
      if (!idbAvailable) {
        warnings.push(MIGRATION_WARNING);
        return { snapshot, version: 0, warnings };
      }
      const result = await save(snapshot, 0);
      if (result.ok) return { snapshot, version: result.version, warnings };
      if (result.reason === 'stale') {
        try {
          const handle = await ensureDb();
          const record = await getOne<unknown>(handle, GAMES_STORE, id);
          if (record !== undefined) {
            const parsed = parseRecord(record);
            if (parsed !== 'corrupt') return { snapshot: parsed.snapshot, version: parsed.version, warnings };
          }
        } catch {}
      }
      warnings.push(MIGRATION_WARNING);
      return { snapshot, version: 0, warnings };
    }
    if (!idbAvailable) warnings.push(STORAGE_WARNING);
    return { snapshot: null, version: 0, warnings };
  }

  async function save(snapshot: WorkspaceSnapshot, expectedVersion: number): Promise<WorkspaceSaveResult> {
    let valid: WorkspaceSnapshot;
    try { valid = validateWorkspaceSnapshot(snapshot); }
    catch (error) { return { ok: false, reason: 'storage', message: error instanceof Error ? error.message : 'Invalid workspace snapshot.' }; }
    const id = valid.game.id;
    try {
      const handle = await ensureDb();
      const version = await casSave(handle, id, expectedVersion, valid);
      if (version === null) return { ok: false, reason: 'stale', message: 'Another tab saved a newer version first.' };
      return { ok: true, version };
    } catch { return { ok: false, reason: 'storage', message: STORAGE_WARNING }; }
  }

  function deleteRecords(handle: IDBDatabase, stores: string[], remove: (tx: IDBTransaction) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = handle.transaction(stores, 'readwrite'); } catch (error) { reject(error); return; }
      let settled = false;
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error instanceof Error ? error : new Error('Delete failed')); } };
      try { remove(tx); } catch (error) { try { tx.abort(); } catch {} fail(error); return; }
      tx.oncomplete = () => { if (!settled) { settled = true; resolve(); } };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error);
    });
  }

  function deleteAudioKeys(tx: IDBTransaction, gameId: string): void {
    const store = tx.objectStore(AUDIO_STORE);
    const keys = store.index(AUDIO_INDEX).getAllKeys(gameId);
    keys.onsuccess = () => { for (const key of keys.result) store.delete(key); };
    keys.onerror = () => { try { tx.abort(); } catch {} };
  }

  function deleteOne(handle: IDBDatabase, id: string): Promise<void> {
    return deleteRecords(handle, [GAMES_STORE, RECOVERY_STORE, AUDIO_STORE], tx => {
      tx.objectStore(GAMES_STORE).delete(id);
      tx.objectStore(RECOVERY_STORE).delete(id);
      deleteAudioKeys(tx, id);
    });
  }

  async function remove(id: string): Promise<SaveResult> {
    let durableDeleted = false;
    try {
      const handle = await ensureDb();
      await deleteOne(handle, id);
      durableDeleted = true;
    } catch {
      if (!unavailable) return { ok: false, message: STORAGE_WARNING };
    }
    const legacyResult = legacy.remove(id);
    return durableDeleted ? { ok: true } : legacyResult;
  }

  async function saveRecovery(snapshot: WorkspaceSnapshot): Promise<SaveResult> {
    let valid: WorkspaceSnapshot;
    try { valid = validateWorkspaceSnapshot(snapshot); }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'Invalid workspace snapshot.' }; }
    try {
      const handle = await ensureDb();
      await putOne(handle, RECOVERY_STORE, { id: valid.game.id, snapshot: valid });
      return { ok: true };
    } catch { return { ok: false, message: STORAGE_WARNING }; }
  }

  async function loadRecovery(id: string): Promise<WorkspaceSnapshot | null> {
    try {
      const handle = await ensureDb();
      const record = await getOne<RecoveryRecord>(handle, RECOVERY_STORE, id);
      if (!record) return null;
      const snapshot = validateWorkspaceSnapshot({ game: record.snapshot.game, history: toUint8Array(record.snapshot.history) });
      return snapshot.game.id === id ? snapshot : null;
    } catch { return null; }
  }

  async function putAudio(gameId: string, trackId: string, bytes: ArrayBuffer): Promise<SaveResult> {
    const key = audioKey(gameId, trackId);
    if (!key || !(bytes instanceof ArrayBuffer) || bytes.byteLength < 1 || bytes.byteLength > AUDIO_BYTES) {
      return { ok: false, message: STORAGE_WARNING };
    }
    try {
      const handle = await ensureDb();
      await putOne(handle, AUDIO_STORE, { key, gameId, trackId, bytes, size: bytes.byteLength, savedAt: runtime.now() });
      return { ok: true };
    } catch { return { ok: false, message: STORAGE_WARNING }; }
  }

  async function getAudio(gameId: string, trackId: string): Promise<ArrayBuffer | null> {
    const key = audioKey(gameId, trackId);
    if (!key) return null;
    try {
      const handle = await ensureDb();
      const record = await getOne<AudioRecord>(handle, AUDIO_STORE, key);
      if (!record || record.gameId !== gameId || record.trackId !== trackId) return null;
      return record.bytes instanceof ArrayBuffer ? record.bytes : null;
    } catch { return null; }
  }

  async function hasAudio(gameId: string, trackId: string): Promise<boolean> {
    const key = audioKey(gameId, trackId);
    if (!key) return false;
    try {
      const handle = await ensureDb();
      return await countOne(handle, AUDIO_STORE, key) > 0;
    } catch { return false; }
  }

  async function removeAudio(gameId: string, trackId: string): Promise<void> {
    const key = audioKey(gameId, trackId);
    if (!key) return;
    try {
      const handle = await ensureDb();
      await deleteRecords(handle, [AUDIO_STORE], tx => { tx.objectStore(AUDIO_STORE).delete(key); });
    } catch {}
  }

  async function removeGameAudio(gameId: string): Promise<void> {
    if (!isGameId(gameId)) return;
    try {
      const handle = await ensureDb();
      await deleteRecords(handle, [AUDIO_STORE], tx => deleteAudioKeys(tx, gameId));
    } catch {}
  }

  async function listAudio(gameId: string): Promise<string[]> {
    if (!isGameId(gameId)) return [];
    try {
      const handle = await ensureDb();
      const keys = await getIndexKeys(handle, AUDIO_STORE, AUDIO_INDEX, gameId);
      const prefix = `${gameId}:`;
      return keys
        .filter((key): key is string => typeof key === 'string' && key.startsWith(prefix))
        .map(key => key.slice(prefix.length))
        .filter(trackId => AUDIO_ID.test(trackId))
        .sort();
    } catch { return []; }
  }

  function rememberedPlayer(id: string): string | null {
    return legacy.rememberedPlayer(id);
  }
  function rememberPlayer(gameId: string, playerId: string): SaveResult {
    return legacy.rememberPlayer(gameId, playerId);
  }
  function close(): void {
    closed = true;
    if (db) { try { db.close(); } catch {} db = null; }
    openPromise = null;
  }

  return { list, load, save, remove, saveRecovery, loadRecovery, rememberedPlayer, rememberPlayer, putAudio, getAudio, hasAudio, removeAudio, removeGameAudio, listAudio, close };
}

export function browserWorkspaceRepository(runtime: Runtime): WorkspaceRepository {
  const win = (globalThis as { window?: { indexedDB?: IDBFactory; localStorage?: Storage } }).window;
  let storage: Storage | undefined;
  if (win) { try { storage = win.localStorage; } catch { storage = undefined; } }
  return createWorkspaceRepository({ indexedDB: win?.indexedDB, storage, runtime });
}
