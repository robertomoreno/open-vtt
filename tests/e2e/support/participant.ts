import type { Browser, BrowserContext, Page } from '@playwright/test';
import { APP_URL } from '../config';
import { GatherApp } from '../pages/gather-app';

export class Participant {
  private constructor(
    readonly app: GatherApp,
    private readonly context: BrowserContext,
  ) {}

  static async create(browser: Browser): Promise<Participant> {
    const context = await browser.newContext({ baseURL: APP_URL });
    try {
      const page = await context.newPage();
      return new Participant(new GatherApp(page), context);
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }

  get page(): Page {
    return this.app.page;
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}
