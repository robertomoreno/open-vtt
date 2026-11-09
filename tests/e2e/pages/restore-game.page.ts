import type { Locator, Page } from '@playwright/test';

export class RestoreGamePage {
  readonly page: Page;
  readonly hostAsSelect: Locator;
  readonly openButton: Locator;
  readonly replaceOpenButton: Locator;
  readonly cancelButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.hostAsSelect = page.getByLabel('Host as player');
    this.openButton = page.getByRole('button', { name: /^(Open game|Replace saved game and open)$/ });
    this.replaceOpenButton = page.getByRole('button', { name: 'Replace saved game and open', exact: true });
    this.cancelButton = page.getByRole('button', { name: 'Cancel', exact: true });
  }

  async open(): Promise<void> {
    await this.openButton.click();
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
  }
}
