import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir:'tests/e2e',timeout:180000,expect:{timeout:15000},workers:1,fullyParallel:false,
 use:{baseURL:'http://localhost:5173',trace:'retain-on-failure',actionTimeout:15000},
 webServer:{command:'npm run dev',url:'http://localhost:5173',reuseExistingServer:!process.env.CI,timeout:30000},
 projects:[
  ...(['chromium','firefox','webkit'] as const).map(browserName=>({name:browserName,testIgnore:['**/connections.spec.ts','**/provider-gate.spec.ts'],use:{browserName}})),
  {name:'interoperability',testMatch:['**/connections.spec.ts','**/provider-gate.spec.ts']}
 ]
});
