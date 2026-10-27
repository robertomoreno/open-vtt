import { test,expect } from '@playwright/test';
import { createGame } from './helpers';
test('denied browser storage leaves local play and downloads usable',async({page})=>{
 await page.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new Error('Storage denied');}}));await createGame(page);await expect(page.getByText(/Browser save unavailable/)).toBeVisible();await page.locator('#roll').click();const promise=page.waitForEvent('download');await page.locator('#download').click();expect((await promise).suggestedFilename()).toMatch(/\.json$/);
});
test('missing WebRTC explains unsupported connection operations without crashing',async({page})=>{
 await page.addInitScript(()=>Object.defineProperty(window,'RTCPeerConnection',{value:undefined}));await page.goto('/');await expect(page.getByText(/WebRTC is unavailable/)).toBeVisible();await createGame(page);await expect(page.locator('#invite')).toBeDisabled();await expect(page.locator('#roll')).toBeEnabled();
});
