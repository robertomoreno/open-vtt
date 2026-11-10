import { defineConfig } from '@playwright/test';
import { APP_URL, LOCAL_RELAY_URL } from './tests/e2e/config';

export default defineConfig({
 testDir:'tests/e2e',timeout:180000,expect:{timeout:15000},workers:1,fullyParallel:false,
 use:{baseURL:APP_URL,trace:'retain-on-failure',actionTimeout:15000},
 // Local-only: start the bundled loopback relay and a dedicated dev server that
 // uses it. The dedicated dev server pins provider, URLs, and redundancy so
 // ambient environment variables cannot select Nostr or inject redundancy. It
 // runs on 5174 so it never reuses a developer's app on 5173 and cannot
 // silently fall back to the public endpoint.
 webServer:[
   {command:'npm run signal:start',port:4444,reuseExistingServer:true,timeout:30000},
   {command:`VITE_GATHER_SIGNALING_PROVIDER=wss VITE_GATHER_SIGNALING_URLS=${LOCAL_RELAY_URL} VITE_GATHER_SIGNALING_REDUNDANCY= npm run dev:e2e`,url:APP_URL,reuseExistingServer:false,timeout:30000},
 ],
 projects:[
  ...(['chromium','firefox','webkit'] as const).map(browserName=>({name:browserName,testIgnore:['**/connections.spec.ts','**/provider-gate.spec.ts','**/chat.spec.ts','**/audio.spec.ts','**/nostr-gate.spec.ts'],use:{browserName}})),
  {name:'interoperability',testMatch:['**/connections.spec.ts','**/provider-gate.spec.ts']},
  {name:'chat',testMatch:['**/chat.spec.ts'],use:{browserName:'chromium'}},
  {name:'audio',testMatch:['**/audio.spec.ts'],use:{browserName:'chromium'}}
 ]
});
