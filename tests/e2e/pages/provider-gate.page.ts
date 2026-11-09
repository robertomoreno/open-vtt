import { expect, type Locator, type Page } from '@playwright/test';

const FIXTURE = '/tests/e2e/fixtures/provider-gate.html';
const LARGE_BYTES = 1_500_000;

function expectedLargeValue(seed: number): string {
  const bytes = Buffer.alloc(LARGE_BYTES);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + seed * 17 + (i >> 8)) & 255;
  return bytes.toString('base64');
}

export class ProviderGatePage {
  readonly page: Page;
  readonly roomLinkInput: Locator;
  readonly participantInput: Locator;
  readonly connectButton: Locator;
  readonly seedInput: Locator;
  readonly valueInput: Locator;
  readonly publishButton: Locator;
  readonly publishLargeButton: Locator;
  readonly closeButton: Locator;
  readonly phase: Locator;
  readonly opens: Locator;
  readonly received: Locator;

  constructor(page: Page) {
    this.page = page;
    this.roomLinkInput = page.getByLabel('Room link');
    this.participantInput = page.getByLabel('Participant');
    this.connectButton = page.getByRole('button', { name: 'Connect' });
    this.seedInput = page.getByLabel('Seed');
    this.valueInput = page.getByLabel('Value');
    this.publishButton = page.getByRole('button', { name: 'Publish value' });
    this.publishLargeButton = page.getByRole('button', { name: 'Publish large value' });
    this.closeButton = page.getByRole('button', { name: 'Close' });
    this.phase = page.locator('#phase');
    this.opens = page.locator('#opens');
    this.received = page.locator('#received');
  }

  async open(link: string, participant: string): Promise<void> {
    await this.page.goto(FIXTURE);
    await this.roomLinkInput.fill(link);
    await this.participantInput.fill(participant);
    await this.connectButton.click();
  }

  async publish(value: string): Promise<void> {
    await this.valueInput.fill(value);
    await this.publishButton.click();
  }

  async publishLarge(seed: number): Promise<void> {
    await this.seedInput.fill(String(seed));
    await this.publishLargeButton.click();
  }

  largeValue(key: string): Locator {
    return this.page.locator(`[data-large="${key}"]`);
  }

  async expectLargeValue(key: string, seed: number): Promise<void> {
    await expect(this.largeValue(key)).toHaveText(expectedLargeValue(seed), { timeout: 30_000 });
  }

  async closeConnection(): Promise<void> {
    await this.closeButton.click();
  }
}
