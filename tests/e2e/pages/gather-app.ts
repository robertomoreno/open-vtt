import { expect, type Page } from '@playwright/test';
import { PlayerChooserPage } from './player-chooser.page';
import { RestoreGamePage } from './restore-game.page';
import { ShareRoomPage } from './share-room.page';
import { StartPage } from './start.page';
import { TablePage } from './table.page';

export class GatherApp {
  readonly page: Page;
  readonly start: StartPage;
  readonly table: TablePage;
  readonly playerChooser: PlayerChooserPage;
  readonly restore: RestoreGamePage;
  readonly share: ShareRoomPage;

  constructor(page: Page) {
    this.page = page;
    this.start = new StartPage(page);
    this.table = new TablePage(page);
    this.playerChooser = new PlayerChooserPage(page);
    this.restore = new RestoreGamePage(page);
    this.share = new ShareRoomPage(page);
  }

  async createGame(name = 'The Lantern Road', creator = 'Alex'): Promise<void> {
    await this.start.goto();
    await this.start.createGame(name, creator);
    await expect(this.table.rollButton).toBeEnabled();
  }

  async openSharedRoom(): Promise<string> {
    await this.table.openRoom();
    return this.share.waitForLink();
  }

  async joinSharedRoom(link: string): Promise<void> {
    await this.page.goto(link);
    const ready = this.table.rollButton
      .or(this.playerChooser.savedPlayerSelect)
      .or(this.playerChooser.joinSelectedButton);
    await expect(ready.first()).toBeVisible({ timeout: 60_000 });
  }

  async claimPlayer(name: string): Promise<void> {
    await this.playerChooser.claim(name);
    await expect(this.table.rollButton).toBeEnabled({ timeout: 60_000 });
  }
}
