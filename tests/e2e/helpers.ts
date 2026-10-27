import { expect,type Page } from '@playwright/test';
export async function createGame(page:Page,name='The Lantern Road') {
 await page.goto('/');await page.getByLabel('Game name',{exact:true}).fill(name);await page.getByLabel('Your name',{exact:true}).fill('Alex');await page.getByRole('button',{name:'Create game'}).click();await expect(page.locator('#roll')).toBeEnabled();
}
export async function exchange(host:Page,guest:Page) {
 await host.locator('#invite').click();await host.locator('#create-signal').click();const output=host.locator('#signal-output');await expect(output).toHaveValue(/#invite=/,{timeout:40000});const invite=await output.inputValue();
 await guest.goto('/');await guest.getByLabel('Invitation link or code',{exact:true}).fill(invite);await guest.getByRole('button',{name:'Open invitation'}).click();await guest.getByRole('button',{name:'Create reply',exact:true}).click();await expect(guest.locator('#signal-output')).toHaveValue(/#reply=/,{timeout:40000});const reply=await guest.locator('#signal-output').inputValue();
 await host.getByLabel('Reply link or code',{exact:true}).fill(reply);await host.locator('#accept-reply').click();await expect(guest.locator('#claim-name')).toBeVisible({timeout:50000});
 const done=host.getByRole('button',{name:'Done',exact:true});await expect(done).toBeVisible();await done.click();
}
export async function claimNew(host:Page,guest:Page,name:string) {
 await guest.getByLabel('Player name',{exact:true}).fill(name);await guest.locator('#claim-new').click();await host.getByRole('button',{name:'Approve',exact:true}).click();await expect(guest.locator('#roll')).toBeEnabled();
}
export async function countRolls(page:Page,count:number){await expect(page.locator('[data-roll]')).toHaveCount(count);}
