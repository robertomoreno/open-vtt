import { defineConfig } from '@playwright/test';
import { APP_URL } from './tests/e2e/config';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/nostr-gate.spec.ts',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  use: { baseURL: APP_URL, trace: 'retain-on-failure', actionTimeout: 15_000 },
  webServer: [
    {
      command: 'VITE_GATHER_SIGNALING_URLS= VITE_GATHER_SIGNALING_PROVIDER=nostr VITE_GATHER_SIGNALING_REDUNDANCY=8 npm run dev:e2e',
      url: APP_URL,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
