import { expect, type Locator, type Page } from '@playwright/test';

export class ShareRoomPage {
  readonly page: Page;
  readonly linkOutput: Locator;

  constructor(page: Page) {
    this.page = page;
    this.linkOutput = page.getByLabel('Room link');
  }

  async waitForLink(): Promise<string> {
    await expect(this.linkOutput).toHaveValue(/\S/, { timeout: 40_000 });
    return this.linkOutput.inputValue();
  }
}
