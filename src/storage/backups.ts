import type { Game, Runtime } from '../game/types';
import type { WorkspaceSnapshot } from '../game/sync-types';
import { check, object, validateGame } from '../game/validation';
import { createWorkspace, validateWorkspaceSnapshot } from '../game/workspace';
import { ENCODED_OPERATION_BYTES, JSON_BACKUP_BYTES, LEGACY_IMPORT_BYTES } from '../network/limits';

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
function encodeBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  return btoa(binary);
}
function decodeBase64(value: unknown): Uint8Array {
  check(typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0, 'Invalid base64 history.');
  let binary: string;
  try { binary = atob(value); } catch { throw new Error('Invalid base64 history.'); }
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function toBackup(snapshot: WorkspaceSnapshot): { format: string; formatVersion: number; game: Game; history: { modelVersion: 1; encoding: 'base64'; update: string } } {
  const { game, history } = validateWorkspaceSnapshot(snapshot);
  return { format: 'gather-game', formatVersion: 2, game, history: { modelVersion: 1, encoding: 'base64', update: encodeBase64(history) } };
}

export function serializeBackup(snapshot: WorkspaceSnapshot): string {
  return JSON.stringify(toBackup(snapshot));
}

export function downloadBackup(snapshot: WorkspaceSnapshot): void {
  const backup = toBackup(snapshot);
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `gather-${backup.game.id}.json`;
  document.body.append(anchor);
  try { anchor.click(); }
  finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

export function parseBackup(text: string, runtime: Runtime): WorkspaceSnapshot {
  check(typeof text === 'string', 'Invalid backup.');
  const bytes = byteLength(text);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('This is not a readable JSON backup file.'); }
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid backup.');
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, 'format')) {
    check(bytes <= JSON_BACKUP_BYTES, 'Backup file is too large.');
    const outer = object(record, ['format', 'formatVersion', 'game', 'history']);
    check(outer.format === 'gather-game', 'Unsupported backup format.');
    check(outer.formatVersion === 2, 'Unsupported backup version.');
    const history = object(outer.history, ['modelVersion', 'encoding', 'update']);
    check(history.modelVersion === 1, 'Unsupported history version.');
    check(history.encoding === 'base64', 'Unsupported history encoding.');
    const update = decodeBase64(history.update);
    check(update.byteLength > 0 && update.byteLength <= ENCODED_OPERATION_BYTES, 'History is too large.');
    return validateWorkspaceSnapshot({ game: outer.game as Game, history: update });
  }
  if (record.schemaVersion === 1) {
    check(bytes <= LEGACY_IMPORT_BYTES, 'Game files must be at most 1 MiB.');
    const workspace = createWorkspace(validateGame(record), runtime);
    try { return workspace.getSnapshot(); }
    finally { workspace.destroy(); }
  }
  throw new Error('Unsupported backup format.');
}

export async function parseBackupFile(file: File, runtime: Runtime): Promise<WorkspaceSnapshot> {
  check(file.size <= JSON_BACKUP_BYTES, 'Backup file is too large.');
  return parseBackup(await file.text(), runtime);
}
