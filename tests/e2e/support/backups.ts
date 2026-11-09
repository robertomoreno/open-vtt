import { readFile } from 'node:fs/promises';
import type { LocalEdit } from '../../../src/game/sync-types';
import { createWorkspace } from '../../../src/game/workspace';
import { parseBackup, serializeBackup } from '../../../src/storage/backups';
import { namedRuntime } from '../../helpers/workspace';

export async function forkBackupFile(
  path: string,
  edit: LocalEdit,
  label: string,
): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const text = await readFile(path, 'utf8');
  const runtime = namedRuntime(label);
  const snapshot = parseBackup(text, runtime);
  const workspace = createWorkspace(snapshot, runtime);
  workspace.applyLocal(edit);
  const forked = workspace.getSnapshot();
  workspace.destroy();
  const serialized = serializeBackup(forked);
  return {
    name: `gather-${label}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(serialized, 'utf8'),
  };
}
