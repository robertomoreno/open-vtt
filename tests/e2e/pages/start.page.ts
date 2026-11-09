import type { Locator, Page } from '@playwright/test';

type FileInput = Parameters<Locator['setInputFiles']>[0];

export class StartPage {
  readonly page: Page;
  readonly gameNameInput: Locator;
  readonly creatorNameInput: Locator;
  readonly createGameButton: Locator;
  readonly loadStateFileInput: Locator;
  readonly continueButtons: Locator;
  readonly emptyState: Locator;

  constructor(page: Page) {
    this.page = page;
    this.gameNameInput = page.getByLabel('Game name', { exact: true });
    this.creatorNameInput = page.getByLabel('Your name', { exact: true });
    this.createGameButton = page.getByRole('button', { name: 'Create game' });
    this.loadStateFileInput = page.getByLabel('Load state file');
    this.continueButtons = page.getByRole('button', { name: /Continue/ });
    this.emptyState = page.getByText('No games saved here yet.');
  }

  async goto(path = '/'): Promise<void> {
    await this.page.goto(path);
  }

  async createGame(name: string, creator: string): Promise<void> {
    await this.gameNameInput.fill(name);
    await this.creatorNameInput.fill(creator);
    await this.createGameButton.click();
  }

  async importFile(file: FileInput): Promise<void> {
    await this.loadStateFileInput.setInputFiles(file);
  }

  savedGame(name: string): Locator {
    return this.page.locator('article.save', { hasText: name });
  }

  async continueGame(name: string): Promise<void> {
    await this.savedGame(name).getByRole('button', { name: /Continue/ }).click();
  }

  deleteButton(name: string): Locator {
    return this.page.getByRole('button', { name: `Delete ${name}`, exact: true });
  }
}
