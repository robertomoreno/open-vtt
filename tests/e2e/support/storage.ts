import type { Page } from '@playwright/test';

type SavedGameOptions = { rolls?: number };

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
