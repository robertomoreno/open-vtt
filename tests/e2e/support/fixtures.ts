import { test as base } from '@playwright/test';
import { GatherApp } from '../pages/gather-app';

type AppFixtures = { app: GatherApp };

export const test = base.extend<AppFixtures>({
  app: async ({ page }, use) => {
    await use(new GatherApp(page));
  },
});

export { expect } from '@playwright/test';
