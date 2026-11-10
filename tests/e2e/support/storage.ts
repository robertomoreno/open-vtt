import type { Page } from '@playwright/test';

type SavedGameOptions = { rolls?: number };
type SavedAudioOptions = { gameName: string; trackName: string };

export async function waitForSavedGame(page: Page, options: SavedGameOptions = {}): Promise<void> {
  await page.waitForFunction(({ rolls }: SavedGameOptions) => new Promise<boolean>((resolve) => {
    const request = indexedDB.open('gather-workspaces');
    request.onerror = () => resolve(false);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('games')) { db.close(); resolve(false); return; }
      const all = db.transaction('games', 'readonly').objectStore('games').getAll();
      all.onsuccess = () => {
        const saved = all.result.some((record: any) => {
          const game = record?.snapshot?.game;
          return Boolean(game) && (rolls === undefined || game.rolls.length >= rolls);
        });
        db.close();
        resolve(saved);
      };
      all.onerror = () => { db.close(); resolve(false); };
    };
  }), options);
}

/**
 * Polls the durable save until the named game's encoded history contains the
 * track name.
 *
 * The history is a Yjs update whose string values are stored as raw UTF-8, so
 * searching the saved bytes proves that audio metadata reached durable storage
 * without importing Yjs into the browser page.
 */
export async function waitForSavedAudio(page: Page, gameName: string, trackName: string): Promise<void> {
  await page.waitForFunction(({ gameName, trackName }: SavedAudioOptions) => new Promise<boolean>((resolve) => {
    const request = indexedDB.open('gather-workspaces');
    request.onerror = () => resolve(false);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('games')) { db.close(); resolve(false); return; }
      const all = db.transaction('games', 'readonly').objectStore('games').getAll();
      all.onsuccess = () => {
        const needle = new TextEncoder().encode(trackName);
        const contains = (value: unknown): boolean => {
          let bytes: Uint8Array | null = null;
          if (value instanceof Uint8Array) bytes = value;
          else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
          else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
          if (bytes === null) return false;
          outer: for (let start = 0; start + needle.length <= bytes.length; start++) {
            for (let offset = 0; offset < needle.length; offset++) {
              if (bytes[start + offset] !== needle[offset]) continue outer;
            }
            return true;
          }
          return false;
        };
        const saved = all.result.some((record: any) =>
          record?.snapshot?.game?.name === gameName && contains(record?.snapshot?.history));
        db.close();
        resolve(saved);
      };
      all.onerror = () => { db.close(); resolve(false); };
    };
  }), { gameName, trackName }, { timeout: 60_000 });
}
