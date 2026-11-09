import { expect, type Locator, type Page } from '@playwright/test';

export class PlayerChooserPage {
  readonly page: Page;
  readonly savedPlayerSelect: Locator;
  readonly joinSelectedButton: Locator;
  readonly createForm: Locator;
  readonly cancelButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.savedPlayerSelect = page.getByLabel('Available saved player');
    this.joinSelectedButton = page.getByRole('button', { name: /^Join as/ });
    this.createForm = page.locator('#create-player-form');
    this.cancelButton = page.getByRole('button', { name: 'Cancel', exact: true });
  }

  async claim(name: string): Promise<void> {
    const option = this.savedPlayerSelect.locator('option', { hasText: name }).first();
    await expect(option).toBeAttached({ timeout: 60_000 });
    const value = await option.getAttribute('value');
    if (!value) throw new Error(`No saved player value found for "${name}".`);
    await this.savedPlayerSelect.selectOption(value);
    await this.joinSelectedButton.click();
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
  }
}
