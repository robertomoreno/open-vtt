import { expect, type Locator, type Page } from '@playwright/test';

export type AudioUpload = { name: string; mimeType: string; buffer: Buffer };

/**
 * The provisional music panel mounted in the table view, plus the hidden audio
 * element owned by the persistent controller.
 *
 * Range inputs are set through the same events the panel listens to: progress and
 * shared gain commit on `change`, while the device volume is local and immediate
 * on `input`. Clicking **Enable sound** is an explicit gesture rather than an
 * assumption that headless automation permits autoplay.
 */
export class MusicPanel {
  readonly page: Page;
  readonly section: Locator;
  readonly library: Locator;
  readonly fileInput: Locator;
  readonly addButton: Locator;
  readonly playButton: Locator;
  readonly progress: Locator;
  readonly gain: Locator;
  readonly local: Locator;
  readonly status: Locator;
  readonly soundButton: Locator;
  readonly audio: Locator;

  constructor(page: Page) {
    this.page = page;
    this.section = page.locator('.music');
    this.library = page.locator('.music-tracks');
    this.fileInput = page.locator('#music-file');
    this.addButton = page.locator('#music-add');
    this.playButton = page.locator('#music-play');
    this.progress = page.locator('#music-progress');
    this.gain = page.locator('#music-gain');
    this.local = page.locator('#music-local');
    this.status = page.locator('#music-status');
    this.soundButton = page.locator('#music-enable-sound');
    this.audio = page.locator('#music-audio');
  }

  trackRow(name: string): Locator {
    return this.page.locator('li[data-track]', { hasText: name }).first();
  }

  async upload(file: AudioUpload): Promise<void> {
    await expect(this.section).toBeVisible();
    await this.fileInput.setInputFiles(file);
  }

  async select(name: string): Promise<void> {
    const row = this.trackRow(name);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: `Select ${name}`, exact: true }).click();
  }

  async toggle(): Promise<void> {
    await this.playButton.click();
  }

  async seek(ms: number): Promise<void> {
    await this.progress.evaluate((element, value) => {
      const input = element as HTMLInputElement;
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, ms);
  }

  async setGain(value: number): Promise<void> {
    await this.gain.evaluate((element, next) => {
      const input = element as HTMLInputElement;
      input.value = String(next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  }

  async setLocal(value: number): Promise<void> {
    await this.local.evaluate((element, next) => {
      const input = element as HTMLInputElement;
      input.value = String(next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  }

  /** A blocked autoplay policy is recoverable only through this local gesture. */
  async enableSoundIfNeeded(): Promise<void> {
    try {
      await this.soundButton.waitFor({ state: 'visible', timeout: 5_000 });
    } catch {
      return;
    }
    await this.soundButton.click({ timeout: 5_000 }).catch(() => {});
  }

  async currentTime(): Promise<number> {
    return this.audio.evaluate((element) => {
      const audio = element as HTMLAudioElement;
      return Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    });
  }

  gainValue(): Locator {
    return this.gain;
  }

  localValue(): Locator {
    return this.local;
  }
}
