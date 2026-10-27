import { test,expect,chromium,firefox,webkit,type BrowserType } from '@playwright/test';
import { createGame,exchange,claimNew,countRolls } from './helpers';
const engines:{[key:string]:BrowserType}={chromium,firefox,webkit};
for(const [hostEngine,guestEngine] of [['chromium','chromium'],['firefox','firefox'],['webkit','webkit'],['chromium','firefox'],['firefox','chromium'],['chromium','webkit'],['webkit','chromium']]){
 test(`${hostEngine} host ↔ ${guestEngine} guests: real channels, approval, history, reclaim and host loss`,async()=>{
  test.setTimeout(300000);
  const hostBrowser=await engines[hostEngine].launch(),guestBrowser=await engines[guestEngine].launch();
  try{
   const hc=await hostBrowser.newContext({baseURL:'http://localhost:5173'}),h=await hc.newPage();
   const c1=await guestBrowser.newContext({baseURL:'http://localhost:5173'}),g1=await c1.newPage(),c2=await guestBrowser.newContext({baseURL:'http://localhost:5173'}),g2=await c2.newPage();
   await createGame(h);await exchange(h,g1);await claimNew(h,g1,'Bea');await h.locator('#roll').click();await g1.getByRole('combobox',{name:'Die',exact:true}).selectOption('6');await g1.locator('#roll').click();await countRolls(h,2);
   await exchange(h,g2);
   await g2.getByLabel('Player name',{exact:true}).fill('  bEa  ');await g2.locator('#claim-new').click();await h.getByRole('button',{name:'Approve',exact:true}).click();await expect(g2.getByText('Duplicate player ID or name.')).toBeVisible();
   await claimNew(h,g2,'Cy');await countRolls(g2,2);await g2.locator('#roll').click();for(const p of [h,g1,g2])await countRolls(p,3);
   const expected=await h.locator('[data-roll]').allTextContents();expect(await g1.locator('[data-roll]').allTextContents()).toEqual(expected);expect(await g2.locator('[data-roll]').allTextContents()).toEqual(expected);
   await g1.locator('#leave').click();await expect(h.locator('.roster')).toContainText('Bea · PJ · Offline');
   await exchange(h,g1);await g1.getByRole('combobox',{name:'Available saved player',exact:true}).selectOption({label:'Bea · PJ · Available'});await g1.locator('#claim-existing').click();await h.getByRole('button',{name:'Approve',exact:true}).click();await expect(g1.locator('#roll')).toBeEnabled();await countRolls(g1,3);
   await h.close();await expect(g1.locator('#roll')).toBeDisabled({timeout:20000});await expect(g1.getByText(/Last received state/)).toBeVisible();const download=g1.waitForEvent('download');await g1.locator('#download').click();expect((await download).suggestedFilename()).toMatch(/\.json$/);
  }finally{await hostBrowser.close();await guestBrowser.close();}
 });
}
